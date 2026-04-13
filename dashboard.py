#!/usr/bin/env python3
"""
WMS Real-Time Dashboard
=======================
Handles D2C, D2B SPD, and D2B LTL picking and packing queues.

SLA Rules:
  D2C  → Spreetail & Marklyn: hard deadline 7:30 PM daily
          Order codes starting with "AMZ" or "70": same-day pick & pack (7:30 PM deadline)
          All others: 24 hrs from picking completion
          Priority 4: not picked on Mondays
          Locus robot jobs (JobTypeId=137643): excluded from picking queue

  D2B SPD → 48 hrs from order allocation date
  D2B LTL → 48 hrs from order allocation date

Urgency Levels:
  Past SLA       → SLA breached
  Breaching SLA  → Approaching SLA threshold
  On Track       → Within SLA

Pushes HTML dashboard to GitHub Pages every run.
Schedule via Windows Task Scheduler to run every 5–15 minutes.
"""

import sys

# ── Working hours guard ───────────────────────────────────────────────────────
# Only run Mon–Fri between 07:00 and 20:00 Toronto time
import pytz as _pytz
_now = __import__('datetime').datetime.now(_pytz.timezone("America/Toronto"))
if _now.weekday() > 4:
    print(f"[{_now:%Y-%m-%d %H:%M}] Weekend — skipping refresh.")
    sys.exit(0)
if not (7 <= _now.hour < 20):
    print(f"[{_now:%Y-%m-%d %H:%M}] Outside working hours (07:00–20:00 ET) — skipping.")
    sys.exit(0)
# ─────────────────────────────────────────────────────────────────────────────

import os
import pandas as pd
import snowflake.connector
from datetime import datetime, timedelta, time as dt_time, date
import pytz
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# CONFIG — fill in your credentials
# ──────────────────────────────────────────────────────────────────────────────

SNOWFLAKE = {
    "user":      os.environ.get("SNOWFLAKE_USER",      "eshipper_admin"),
    "password":  os.environ.get("SNOWFLAKE_PASSWORD",  "HdWV6MpeDMW@uyG!"),
    "account":   os.environ.get("SNOWFLAKE_ACCOUNT",   "jra25860.east-us-2.azure"),
    "warehouse": os.environ.get("SNOWFLAKE_WAREHOUSE", "ESHIPPER_READER_WH"),
    "database":  os.environ.get("SNOWFLAKE_DATABASE",  "IUTDGKJ_DEA90311_ESHIPPER_DIRECT_SHARE"),
    "schema":    os.environ.get("SNOWFLAKE_SCHEMA",    "ESHIPPER_SCHEMA"),
}

_BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
PRIORITY_DIR  = _BASE_DIR
HISTORY_CSV   = os.path.join(_BASE_DIR, "daily_history.csv")

TIMEZONE      = "America/Toronto"
WORKDAY_START = dt_time(7, 0)           # 7:00 AM
WORKDAY_END   = dt_time(18, 0)          # 6:00 PM  (11 working hrs/day)
HARD_DEADLINE = dt_time(19, 30)         # 7:30 PM  (Spreetail / Marklyn cutoff)

# D2C — clients with a hard daily shipping deadline (lowercase, partial match)
DEADLINE_CLIENTS    = ["spreetail", "marklyn"]
D2C_SLA_HRS         = 24   # 24 calendar hours from allocation
D2B_SPD_SLA_HRS     = 48   # 48 calendar hours from allocation
D2B_LTL_SLA_HRS     = 48   # 48 calendar hours from allocation

# Locus robot job type — differentiated in D2C picking queue
LOCUS_JOB_TYPE_ID   = 137643

# Shipment order statuses to exclude from all queues
EXCLUDED_SO_STATUSES = (20, 30)   # 20=Shipped, 30=Cancelled

DB = "IUTDGKJ_DEA90311_ESHIPPER_DIRECT_SHARE.ESHIPPER_SCHEMA"

# ──────────────────────────────────────────────────────────────────────────────
# LOGIWA API CONFIG
# ──────────────────────────────────────────────────────────────────────────────
LOGIWA_EMAIL    = os.environ.get("LOGIWA_EMAIL",    "logiwa_api_user1@eshipperplus.com")
LOGIWA_PASSWORD = os.environ.get("LOGIWA_PASSWORD", "eShipper+123")
LOGIWA_BASE     = "https://myapi.logiwa.com"
ON_HOLD_TAG          = "ON HOLD"
LOGIWA_SCAN_PAGES    = 100   # max pages to scan (100 × 50 = 5 000 most-recent orders)
LOGIWA_MAX_SCAN_SECS = 25    # hard wall-clock budget — never block dashboard longer than this


def fetch_on_hold_codes(queue_codes: set = None) -> set:
    """Scan Logiwa API (newest-first pages) for orders tagged ON HOLD.

    Hard wall-clock budget of LOGIWA_MAX_SCAN_SECS so this never hangs the
    dashboard.  Scans up to LOGIWA_SCAN_PAGES pages × 50 orders each.
    The queue_codes parameter is accepted but ignored (kept for call-site compat).
    """
    import ssl, urllib.request as _ur, json as _json, time as _time
    ctx = ssl.create_default_context()
    try:
        auth_req = _ur.Request(
            f"{LOGIWA_BASE}/v3.1/Authorize/token",
            data=_json.dumps({"Email": LOGIWA_EMAIL, "Password": LOGIWA_PASSWORD}).encode(),
            headers={"Content-Type": "application/json"}
        )
        with _ur.urlopen(auth_req, timeout=15, context=ctx) as r:
            token = _json.loads(r.read())["token"]

        hdrs = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        on_hold = set()
        deadline = _time.monotonic() + LOGIWA_MAX_SCAN_SECS

        for page in range(LOGIWA_SCAN_PAGES):
            if _time.monotonic() > deadline:
                logger.warning(f"Logiwa scan: time budget reached at page {page}, stopping")
                break
            req = _ur.Request(
                f"{LOGIWA_BASE}/v3.1/ShipmentOrder/list/i/{page}/s/50",
                headers=hdrs
            )
            with _ur.urlopen(req, timeout=10, context=ctx) as r:
                data = _json.loads(r.read()).get("data", [])
            if not data:
                break
            for order in data:
                tags = [t.get("name", "").upper() for t in order.get("tags", [])]
                if ON_HOLD_TAG in tags:
                    on_hold.add(order["code"])

        logger.info(f"Logiwa ON HOLD codes fetched: {len(on_hold)} orders")
        return on_hold

    except Exception as e:
        logger.warning(f"Logiwa API fetch failed: {e} — ON HOLD filter skipped")
        return set()


# ──────────────────────────────────────────────────────────────────────────────
# SQL QUERIES
# ──────────────────────────────────────────────────────────────────────────────

def _d2c_packing_sql():
    """
    D2C Packing — TASK based.
    SLA reference = ActualFinishDateTime of the latest completed picking task.
    Excludes shipped/deleted orders.
    """
    return f"""
SELECT
    pack.Id                          AS TaskId,
    pack.ShipmentOrderId,
    so.Code                          AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName) AS ClientName,
    c.DisplayName                    AS ClientDisplayName,
    sot.Name                         AS OrderType,
    pack.WaveNo,
    pack.WarehouseId,
    MIN(pick.CreatedDateTime)        AS AllocationDate,
    MAX(pick.ActualFinishDateTime)   AS PickingCompletedAt,
    CASE pack.WarehouseTaskStatusId
        WHEN 1 THEN 'Pending'
        WHEN 2 THEN 'Started'
        WHEN 9 THEN 'Processing'
    END                              AS PackingStatus

FROM {DB}.WAREHOUSETASK             pack

INNER JOIN {DB}.WAREHOUSETASK       pick
        ON pack.ShipmentOrderId      = pick.ShipmentOrderId
       AND pick.WarehouseTaskTypeId  = 1        -- Picking
       AND pick.WarehouseTaskStatusId = 3       -- Completed
       AND pick.Deleted              = 0

INNER JOIN {DB}.SHIPMENTORDER       so  ON pack.ShipmentOrderId  = so.Id  AND so.Deleted  = 0
INNER JOIN {DB}.SHIPMENTORDERTYPE   sot ON so.ShipmentOrderTypeId = sot.Id
INNER JOIN {DB}.CLIENT              c   ON pack.ClientId          = c.Id   AND c.Deleted   = 0

WHERE pack.WarehouseTaskTypeId      = 6               -- Packing
  AND pack.WarehouseTaskStatusId    IN (1, 2, 9)      -- Pending / Started / Processing
  AND pack.Deleted                  = 0
  AND sot.Name                      ILIKE '%D2C%'
  AND so.ActualShipmentDate         IS NULL
  AND so.ShipmentOrderStatusId      NOT IN (20, 30)
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
  AND pack.WarehouseId              = 26771

GROUP BY
    pack.Id, pack.ShipmentOrderId, so.Code,
    COALESCE(c.FullName, c.DisplayName), c.DisplayName, sot.Name, pack.WaveNo,
    pack.WarehouseId, pack.WarehouseTaskStatusId
"""


def _d2c_picking_sql():
    """
    D2C Picking — TASK based.
    SLA reference = CreatedDateTime of the picking task itself.
    Includes both Locus (robot) and Manual picking tasks.
    A 'PickingType' column differentiates them.
    """
    return f"""
SELECT
    wt.Id                            AS TaskId,
    wt.ShipmentOrderId,
    so.Code                          AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName) AS ClientName,
    c.DisplayName                    AS ClientDisplayName,
    sot.Name                         AS OrderType,
    wt.WaveNo,
    wt.WarehouseId,
    wt.CreatedDateTime               AS AllocationDate,
    CASE wt.WarehouseTaskStatusId
        WHEN 1 THEN 'Pending'
        WHEN 2 THEN 'Started'
        WHEN 9 THEN 'Processing'
    END                              AS PickingStatus,
    CASE
        WHEN wj.WarehouseJobTypeId = {LOCUS_JOB_TYPE_ID} THEN 'Locus (Robot)'
        ELSE 'Manual'
    END                              AS PickingType

FROM {DB}.WAREHOUSETASK             wt

LEFT JOIN {DB}.WAREHOUSEJOB         wj  ON wt.WarehouseJobId      = wj.Id

INNER JOIN {DB}.SHIPMENTORDER       so  ON wt.ShipmentOrderId     = so.Id  AND so.Deleted = 0
INNER JOIN {DB}.SHIPMENTORDERTYPE   sot ON so.ShipmentOrderTypeId = sot.Id
INNER JOIN {DB}.CLIENT              c   ON so.ClientId            = c.Id   AND c.Deleted  = 0

WHERE wt.WarehouseTaskTypeId        = 1               -- Picking
  AND wt.WarehouseTaskStatusId      IN (1, 2, 9)      -- Pending / Started / Processing
  AND wt.Deleted                    = 0
  AND sot.Name                      ILIKE '%D2C%'
  AND so.ActualShipmentDate         IS NULL
  AND so.ShipmentOrderStatusId      NOT IN (20, 30)
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
  AND wt.WarehouseId                = 26771
"""


def _packing_base(order_type_pattern):
    """
    D2B Packing — ORDER based.
    SLA reference = ShipmentOrderDate (allocation date).
    """
    return f"""
SELECT
    pick.ShipmentOrderId,
    so.Code                          AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName) AS ClientName,
    c.DisplayName                    AS ClientDisplayName,
    sot.Name                         AS OrderType,
    pick.WaveNo,
    so.WarehouseId,
    pick.PickingCompletedAt,
    pick.TaskCreatedAt               AS AllocationDate,
    CASE pack.PackingStatusId
        WHEN 1 THEN 'Pending'
        WHEN 2 THEN 'Started'
        WHEN 9 THEN 'Processing'
    END                              AS PackingStatus

FROM (
    SELECT
        ShipmentOrderId,
        ClientId,
        WaveNo,
        MIN(CreatedDateTime)         AS TaskCreatedAt,
        MAX(ActualFinishDateTime)    AS PickingCompletedAt
    FROM {DB}.WAREHOUSETASK
    WHERE WarehouseTaskTypeId  = 1
      AND WarehouseTaskStatusId = 3
      AND Deleted = 0
    GROUP BY ShipmentOrderId, ClientId, WaveNo
) pick

INNER JOIN (
    SELECT DISTINCT ShipmentOrderId, WarehouseTaskStatusId AS PackingStatusId
    FROM {DB}.WAREHOUSETASK
    WHERE WarehouseTaskTypeId     = 6
      AND WarehouseTaskStatusId   IN (1, 2, 9)
      AND Deleted                 = 0
) pack ON pick.ShipmentOrderId    = pack.ShipmentOrderId

INNER JOIN {DB}.SHIPMENTORDER     so  ON pick.ShipmentOrderId  = so.Id  AND so.Deleted = 0
INNER JOIN {DB}.SHIPMENTORDERTYPE sot ON so.ShipmentOrderTypeId = sot.Id
INNER JOIN {DB}.CLIENT            c   ON so.ClientId            = c.Id   AND c.Deleted = 0

WHERE sot.Name ILIKE '%{order_type_pattern}%'
  AND so.ActualShipmentDate IS NULL
  AND so.ShipmentOrderStatusId NOT IN (20, 30)
  AND so.Deleted = 0
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
  AND so.WarehouseId = 26771
"""


def _picking_base(order_type_pattern):
    """
    D2B Picking — ORDER based.
    SLA reference = ShipmentOrderDate (allocation date).
    """
    return f"""
SELECT
    wt.ShipmentOrderId,
    so.Code                          AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName) AS ClientName,
    c.DisplayName                    AS ClientDisplayName,
    sot.Name                         AS OrderType,
    so.WarehouseId,
    wt.TaskCreatedAt                 AS AllocationDate,
    CASE wt.PickingStatusId
        WHEN 1 THEN 'Pending'
        WHEN 2 THEN 'Started'
        WHEN 9 THEN 'Processing'
    END                              AS PickingStatus

FROM (
    SELECT
        wt2.ShipmentOrderId,
        wt2.ClientId,
        wt2.WarehouseTaskStatusId    AS PickingStatusId,
        MIN(wt2.CreatedDateTime)     AS TaskCreatedAt
    FROM {DB}.WAREHOUSETASK wt2
    WHERE wt2.WarehouseTaskTypeId    = 1
      AND wt2.WarehouseTaskStatusId  IN (1, 2, 9)
      AND wt2.Deleted                = 0
    GROUP BY wt2.ShipmentOrderId, wt2.ClientId, wt2.WarehouseTaskStatusId
) wt

INNER JOIN {DB}.SHIPMENTORDER     so  ON wt.ShipmentOrderId    = so.Id  AND so.Deleted = 0
INNER JOIN {DB}.SHIPMENTORDERTYPE sot ON so.ShipmentOrderTypeId = sot.Id
INNER JOIN {DB}.CLIENT            c   ON so.ClientId            = c.Id   AND c.Deleted = 0

WHERE sot.Name ILIKE '%{order_type_pattern}%'
  AND so.ActualShipmentDate IS NULL
  AND so.ShipmentOrderStatusId NOT IN (20, 30)
  AND so.Deleted = 0
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
  AND so.WarehouseId = 26771
"""


def _ltl_nopack_sql():
    """
    LTL orders that have been FULLY PICKED but have NO packing tasks at all.
    These need to be physically packed without a system task.
    SLA reference = ShipmentOrderDate (allocation date), 72hr SLA.
    """
    return f"""
SELECT
    so.Id                               AS ShipmentOrderId,
    so.Code                             AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName) AS ClientName,
    c.DisplayName                       AS ClientDisplayName,
    so.WarehouseId,
    so.ShipmentOrderDate                AS AllocationDate,
    MAX(pick.ActualFinishDateTime)      AS PickingCompletedAt,
    '⚠️ No Packing Task'               AS Alert

FROM {DB}.WAREHOUSETASK             pick

INNER JOIN {DB}.SHIPMENTORDER       so  ON pick.ShipmentOrderId  = so.Id  AND so.Deleted = 0
INNER JOIN {DB}.SHIPMENTORDERTYPE   sot ON so.ShipmentOrderTypeId = sot.Id
INNER JOIN {DB}.CLIENT              c   ON so.ClientId           = c.Id   AND c.Deleted  = 0

WHERE pick.WarehouseTaskTypeId      = 1        -- Picking
  AND pick.WarehouseTaskStatusId    = 3        -- Completed
  AND pick.Deleted                  = 0
  AND sot.Name                      ILIKE '%LTL%'
  AND so.ActualShipmentDate         IS NULL
  AND so.ShipmentOrderStatusId      NOT IN (20, 30)
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
  AND so.WarehouseId                = 26771
  AND NOT EXISTS (
      SELECT 1
      FROM {DB}.WAREHOUSETASK pack
      WHERE pack.ShipmentOrderId     = so.Id
        AND pack.WarehouseTaskTypeId = 6        -- Packing
        AND pack.Deleted             = 0
  )

GROUP BY
    so.Id, so.Code,
    COALESCE(c.FullName, c.DisplayName), c.DisplayName,
    so.WarehouseId, so.ShipmentOrderDate
"""


def _open_shortage_sql():
    """
    Open (StatusId=6) and Shortage (StatusId=2) orders for warehouse 26771.
    Simple distinct order count per client — no task joins.
    """
    return f"""
SELECT
    so.Id                                   AS ShipmentOrderId,
    so.Code                                 AS ShipmentOrderCode,
    COALESCE(c.FullName, c.DisplayName)     AS ClientName,
    sos.Name                                AS OrderStatus

FROM {DB}.SHIPMENTORDER                     so
INNER JOIN {DB}.CLIENT                      c   ON so.ClientId              = c.Id  AND c.Deleted = 0
INNER JOIN {DB}.SHIPMENTORDERSTATUS         sos ON so.ShipmentOrderStatusId = sos.Id

WHERE so.WarehouseId                        = 26771
  AND so.ShipmentOrderStatusId              IN (2, 6)
  AND so.Deleted                            = 0
  AND so.ActualShipmentDate                 IS NULL
  AND COALESCE(c.FullName, c.DisplayName)   NOT ILIKE '%test%'
  AND (so.ShipmentOrderStatusId != 6
       OR so.ShipmentOrderDate  >= DATEADD(day, -30, CURRENT_DATE))
"""


def _hourly_today_sql():
    """Picks and packs by hour for today, per client — for the hourly breakdown chart."""
    return f"""
SELECT
    HOUR(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime))  AS hour,
    CASE wt.WarehouseTaskTypeId WHEN 1 THEN 'Picking' ELSE 'Packing' END       AS activitytype,
    COALESCE(c.FullName, c.DisplayName)                                         AS clientname,
    COUNT(DISTINCT wt.ShipmentOrderId)                                          AS orders

FROM {DB}.WAREHOUSETASK                                     wt
INNER JOIN {DB}.SHIPMENTORDER                               so  ON wt.ShipmentOrderId = so.Id AND so.Deleted = 0
INNER JOIN {DB}.CLIENT                                      c   ON so.ClientId        = c.Id AND c.Deleted  = 0

WHERE wt.WarehouseTaskTypeId    IN (1, 6)
  AND wt.WarehouseTaskStatusId  = 3
  AND wt.WarehouseId            = 26771
  AND DATE(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime)) = DATE(CONVERT_TIMEZONE('America/Toronto', CURRENT_TIMESTAMP()))
  AND wt.Deleted                = 0
  AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'

GROUP BY 1, 2, 3
ORDER BY 1, 2
"""


def _hourly_baseline_sql():
    """90th-percentile orders picked/packed per hour across last 45 weekdays — baseline target line."""
    return f"""
WITH daily_hourly AS (
    SELECT
        DATE(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime))  AS work_date,
        HOUR(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime))  AS hour,
        CASE wt.WarehouseTaskTypeId WHEN 1 THEN 'Picking' ELSE 'Packing' END       AS activitytype,
        COUNT(DISTINCT wt.ShipmentOrderId)                                          AS orders
    FROM {DB}.WAREHOUSETASK wt
    INNER JOIN {DB}.SHIPMENTORDER so ON wt.ShipmentOrderId = so.Id AND so.Deleted = 0
    INNER JOIN {DB}.CLIENT        c  ON so.ClientId        = c.Id  AND c.Deleted  = 0
    WHERE wt.WarehouseTaskTypeId   IN (1, 6)
      AND wt.WarehouseTaskStatusId = 3
      AND wt.WarehouseId           = 26771
      AND wt.Deleted               = 0
      AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
      AND DATE(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime))
              BETWEEN DATEADD(day, -60, CURRENT_DATE) AND DATEADD(day, -1, CURRENT_DATE)
      AND DAYOFWEEK(DATE(CONVERT_TIMEZONE('UTC', 'America/Toronto', wt.ActualFinishDateTime)))
              NOT IN (0, 6)   -- exclude Sunday=0, Saturday=6 (Snowflake DAYOFWEEK)
    GROUP BY 1, 2, 3
)
SELECT
    hour,
    activitytype,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY orders) AS max_orders
FROM daily_hourly
GROUP BY 1, 2
ORDER BY 1, 2
"""


def _today_progress_sql(today_str):
    """
    UNION approach — orders appear TWICE if both picking and packing happened today.
    This lets managers count total picked AND total packed independently.

    Rows per order:
      'Picked Today'    → all picking tasks done, at least one completed today
      'Picking Started' → some picking done today but not all tasks complete
      'Packed Today'    → all packing tasks done, at least one completed today
      'Packing Started' → some packing done today but not all tasks complete
    """
    base = f"""
WITH task_stats AS (
    SELECT
        ShipmentOrderId,
        -- Picking counts
        COUNT(CASE WHEN WarehouseTaskTypeId = 1 THEN 1 END)                 AS TotalPicking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 1
                        AND WarehouseTaskStatusId = 3 THEN 1 END)           AS CompletedPicking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 1
                        AND WarehouseTaskStatusId IN (1,2,9) THEN 1 END)    AS PendingPicking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 1
                        AND WarehouseTaskStatusId = 3
                        AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime)) = '{today_str}'
                   THEN 1 END)                                              AS PickedToday,
        MAX(CASE WHEN WarehouseTaskTypeId = 1
                      AND WarehouseTaskStatusId = 3
                      AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime)) = '{today_str}'
                 THEN CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime) END) AS LastPickedAt,
        -- Packing counts
        COUNT(CASE WHEN WarehouseTaskTypeId = 6 THEN 1 END)                 AS TotalPacking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 6
                        AND WarehouseTaskStatusId = 3 THEN 1 END)           AS CompletedPacking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 6
                        AND WarehouseTaskStatusId IN (1,2,9) THEN 1 END)    AS PendingPacking,
        COUNT(CASE WHEN WarehouseTaskTypeId = 6
                        AND WarehouseTaskStatusId = 3
                        AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime)) = '{today_str}'
                   THEN 1 END)                                              AS PackedToday,
        MAX(CASE WHEN WarehouseTaskTypeId = 6
                      AND WarehouseTaskStatusId = 3
                      AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime)) = '{today_str}'
                 THEN CONVERT_TIMEZONE('UTC','America/Toronto',ActualFinishDateTime) END) AS LastPackedAt
    FROM {DB}.WAREHOUSETASK
    WHERE WarehouseTaskTypeId IN (1, 6) AND Deleted = 0
    GROUP BY ShipmentOrderId
    HAVING PickedToday > 0 OR PackedToday > 0
),
orders AS (
    SELECT
        so.Code                                         AS ShipmentOrderCode,
        sot.Name                                        AS OrderType,
        COALESCE(c.FullName, c.DisplayName)             AS ClientName,
        so.WarehouseId,
        ts.*
    FROM task_stats ts
    INNER JOIN {DB}.SHIPMENTORDER     so  ON ts.ShipmentOrderId      = so.Id  AND so.Deleted = 0
    INNER JOIN {DB}.SHIPMENTORDERTYPE sot ON so.ShipmentOrderTypeId  = sot.Id
    INNER JOIN {DB}.CLIENT            c   ON so.ClientId             = c.Id   AND c.Deleted  = 0
    WHERE so.ShipmentOrderStatusId != 30              -- exclude Cancelled only; Shipped (20) is valid progress
      AND (sot.Name ILIKE '%D2C%' OR sot.Name ILIKE '%SPD%' OR sot.Name ILIKE '%LTL%')
      AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
      AND so.WarehouseId = 26771
)"""

    picking_rows = f"""
SELECT
    ShipmentOrderCode, OrderType, ClientName, WarehouseId,
    LastPickedAt                                        AS ActivityTime,
    PickedToday                                         AS TasksDoneToday,
    TotalPicking                                        AS TotalTasks,
    CompletedPicking                                    AS TotalCompleted,
    'Picking'                                           AS ActivityType,
    CASE WHEN PendingPicking = 0 THEN 'Fully Picked'
         ELSE 'Partially Picked' END                    AS CompletionStatus
FROM orders
WHERE PickedToday > 0"""

    packing_rows = f"""
SELECT
    ShipmentOrderCode, OrderType, ClientName, WarehouseId,
    LastPackedAt                                        AS ActivityTime,
    PackedToday                                         AS TasksDoneToday,
    TotalPacking                                        AS TotalTasks,
    CompletedPacking                                    AS TotalCompleted,
    'Packing'                                           AS ActivityType,
    CASE WHEN PendingPacking = 0 THEN 'Fully Packed'
         ELSE 'Partially Packed' END                    AS CompletionStatus
FROM orders
WHERE PackedToday > 0"""

    return f"""
{base}
{picking_rows}
UNION ALL
{packing_rows}
ORDER BY
    CASE CompletionStatus
        WHEN 'Fully Packed'      THEN 1
        WHEN 'Partially Packed'  THEN 2
        WHEN 'Fully Picked'      THEN 3
        ELSE                          4
    END,
    ClientName, ShipmentOrderCode
"""


def _daily_history_sql():
    """
    60-day rolling window of orders picked and packed per day, broken down by order type.
    Also returns DailyAllocated (orders allocated that day) as a volume proxy for fair baselines.
    Last 15 days are shown in the chart; days 16-60 are used to compute the efficiency baseline.
    """
    return f"""
WITH daily_tasks AS (
    SELECT
        DATE(CONVERT_TIMEZONE('UTC','America/Toronto', wt.ActualFinishDateTime)) AS WorkDate,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=1 AND sot.Name ILIKE '%D2C%' THEN wt.ShipmentOrderId END) AS D2C_Picked,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=6 AND sot.Name ILIKE '%D2C%' THEN wt.ShipmentOrderId END) AS D2C_Packed,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=1 AND sot.Name ILIKE '%SPD%' THEN wt.ShipmentOrderId END) AS SPD_Picked,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=6 AND sot.Name ILIKE '%SPD%' THEN wt.ShipmentOrderId END) AS SPD_Packed,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=1 AND sot.Name ILIKE '%LTL%' THEN wt.ShipmentOrderId END) AS LTL_Picked,
        COUNT(DISTINCT CASE WHEN wt.WarehouseTaskTypeId=6 AND sot.Name ILIKE '%LTL%' THEN wt.ShipmentOrderId END) AS LTL_Packed
    FROM {DB}.WAREHOUSETASK wt
    INNER JOIN {DB}.SHIPMENTORDER so  ON wt.ShipmentOrderId     = so.Id  AND so.Deleted = 0
    INNER JOIN {DB}.SHIPMENTORDERTYPE sot ON so.ShipmentOrderTypeId = sot.Id
    INNER JOIN {DB}.CLIENT c              ON so.ClientId             = c.Id  AND c.Deleted = 0
    WHERE wt.WarehouseTaskStatusId = 3
      AND wt.WarehouseTaskTypeId  IN (1, 6)
      AND wt.Deleted = 0
      AND (sot.Name ILIKE '%D2C%' OR sot.Name ILIKE '%SPD%' OR sot.Name ILIKE '%LTL%')
      AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
      AND so.ShipmentOrderStatusId != 30
      AND wt.WarehouseId = 26771
      AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto', wt.ActualFinishDateTime))
            >= DATEADD(day, -60, CURRENT_DATE())
    GROUP BY WorkDate
),
daily_alloc AS (
    -- Orders allocated each day = proxy for that day's incoming workload volume
    SELECT
        DATE(CONVERT_TIMEZONE('UTC','America/Toronto', so.AllocationDateTime)) AS AllocDate,
        COUNT(DISTINCT so.Id) AS DailyAllocated
    FROM {DB}.SHIPMENTORDER so
    INNER JOIN {DB}.SHIPMENTORDERTYPE sot ON so.ShipmentOrderTypeId = sot.Id
    INNER JOIN {DB}.CLIENT c              ON so.ClientId             = c.Id AND c.Deleted = 0
    WHERE so.Deleted = 0
      AND so.ShipmentOrderStatusId != 30
      AND (sot.Name ILIKE '%D2C%' OR sot.Name ILIKE '%SPD%' OR sot.Name ILIKE '%LTL%')
      AND COALESCE(c.FullName, c.DisplayName) NOT ILIKE '%test%'
      AND so.WarehouseId = 26771
      AND DATE(CONVERT_TIMEZONE('UTC','America/Toronto', so.AllocationDateTime))
            >= DATEADD(day, -60, CURRENT_DATE())
    GROUP BY AllocDate
)
SELECT
    t.WorkDate,
    t.D2C_Picked, t.D2C_Packed,
    t.SPD_Picked, t.SPD_Packed,
    t.LTL_Picked, t.LTL_Packed,
    COALESCE(a.DailyAllocated, 0) AS DailyAllocated
FROM daily_tasks t
LEFT JOIN daily_alloc a ON t.WorkDate = a.AllocDate
ORDER BY WorkDate
"""


# Pre-built query strings
D2C_PACKING_SQL     = _d2c_packing_sql()
D2C_PICKING_SQL     = _d2c_picking_sql()
D2B_SPD_PACKING_SQL = _packing_base("SPD")
D2B_SPD_PICKING_SQL = _picking_base("SPD")
D2B_LTL_PACKING_SQL = _packing_base("LTL")
D2B_LTL_PICKING_SQL = _picking_base("LTL")
D2B_LTL_NOPACK_SQL  = _ltl_nopack_sql()
_tz_build         = pytz.timezone(TIMEZONE)
_today_str        = datetime.now(_tz_build).strftime("%Y-%m-%d")
TODAY_PROGRESS_SQL  = _today_progress_sql(_today_str)
DAILY_HISTORY_SQL   = _daily_history_sql()


# ──────────────────────────────────────────────────────────────────────────────
# SNOWFLAKE
# ──────────────────────────────────────────────────────────────────────────────

def query_snowflake(sql):
    logger.debug(f"  Full SQL:\n{sql}")
    conn = snowflake.connector.connect(**SNOWFLAKE)
    try:
        cur = conn.cursor()
        cur.execute(sql)
        cols = [desc[0].lower() for desc in cur.description]   # Snowflake returns UPPERCASE → normalise
        rows = cur.fetchall()
        return pd.DataFrame(rows, columns=cols)
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────────
# PRIORITY LIST HELPERS
# ──────────────────────────────────────────────────────────────────────────────

def load_priority(csv_name):
    """
    Reads a priority CSV from PRIORITY_DIR.
    Expected columns: ClientKeyword, Priority
    Returns empty DataFrame if file missing or malformed.
    """
    path = os.path.join(PRIORITY_DIR, csv_name)
    try:
        df = pd.read_csv(path)
    except FileNotFoundError:
        logger.warning(f"Priority file '{csv_name}' not found — all clients will sort last.")
        return pd.DataFrame(columns=["ClientKeyword", "Priority"])
    if "ClientKeyword" not in df.columns or "Priority" not in df.columns:
        logger.warning(f"Priority file '{csv_name}' missing expected columns — all clients will sort last.")
        return pd.DataFrame(columns=["ClientKeyword", "Priority"])
    df["ClientKeyword"] = df["ClientKeyword"].astype(str).str.strip().str.lower()
    df["Priority"]      = pd.to_numeric(df["Priority"], errors="coerce").fillna(99).astype(int)
    return df


def match_priority(client_name, priority_df):
    """Fuzzy match a client name against priority keyword list."""
    name = str(client_name).strip().lower()
    for _, row in priority_df.iterrows():
        kw = row["ClientKeyword"]
        if kw and (kw in name or name in kw):
            return int(row["Priority"])
    return 99   # not in list → sorted last


# ──────────────────────────────────────────────────────────────────────────────
# URGENCY SCORING
# ──────────────────────────────────────────────────────────────────────────────

STAT_HOLIDAYS = {
    date(2026, 4, 4),   # Good Friday
    date(2026, 5, 18),  # Victoria Day
    date(2026, 7, 1),   # Canada Day
    date(2026, 8, 3),   # Civic Holiday
    date(2026, 9, 7),   # Labour Day
    date(2026, 10, 12), # Thanksgiving
    date(2026, 12, 25), # Christmas
    date(2026, 12, 26), # Boxing Day
}

def _calendar_hours_elapsed(ref_time, now, tz):
    """
    Calendar hours elapsed between ref_time and now.
    Excludes weekends (Sat/Sun) and stat holidays.
    All 24 hours of valid business days count.
    """
    if pd.isna(ref_time):
        return 0.0
    if hasattr(ref_time, "tzinfo") and ref_time.tzinfo is None:
        ref_time = tz.localize(ref_time)
    if ref_time >= now:
        return 0.0

    total = 0.0
    cursor = ref_time

    while cursor.date() <= now.date():
        if cursor.weekday() < 5 and cursor.date() not in STAT_HOLIDAYS:
            day_end      = tz.localize(datetime.combine(cursor.date(), dt_time(23, 59, 59)))
            window_start = cursor
            window_end   = min(now, day_end)
            if window_end > window_start:
                total += (window_end - window_start).total_seconds() / 3600

        next_day = cursor.date() + timedelta(days=1)
        cursor   = tz.localize(datetime.combine(next_day, dt_time(0, 0)))

    return max(0.0, total)


def _urgency(elapsed_hrs, sla_hrs, is_deadline=False, remaining_hrs=0.0,
             at_risk_pct=0.75, critical_pct=1.0):
    """
    Returns (score, level, status_text).

    Deadline clients (Spreetail, Marklyn):
      Level based on hours remaining until 7:30 PM.
      CRITICAL  < 1 h remaining
      AT RISK   < 3 h remaining
      ON TRACK  otherwise

    Rolling SLA clients:
      score = elapsed / sla_hrs
      Thresholds controlled by at_risk_pct / critical_pct:
        Packing  → at_risk=0.75, critical=1.0  (default)
        Picking  → at_risk=0.50, critical=0.75 (tighter — leaves room for packing)
    """
    if is_deadline:
        if remaining_hrs <= 0:
            return 999.0, "Past SLA", "Deadline MISSED"
        workday_hrs = (
            datetime.combine(datetime.today(), HARD_DEADLINE)
            - datetime.combine(datetime.today(), WORKDAY_START)
        ).seconds / 3600
        score = round(elapsed_hrs / max(workday_hrs, 0.001), 3)
        level = "Past SLA" if remaining_hrs < 1 else ("Breaching SLA" if remaining_hrs < 3 else "On Track")
        return score, level, f"{remaining_hrs:.1f}h until 7:30 PM cutoff"
    else:
        score = round(elapsed_hrs / sla_hrs, 3)
        level = "Past SLA" if score >= critical_pct else ("Breaching SLA" if score >= at_risk_pct else "On Track")
        return score, level, f"{elapsed_hrs:.1f}h elapsed of {sla_hrs}h SLA"


def _d2c_urgency(row, now, tz, ref_col, is_picking=False):
    """
    D2C urgency — deadline clients use 7:30 PM hard cutoff,
    all others use rolling 24hr SLA from ref_col.
    is_picking=True applies tighter thresholds (50%/75%) to leave room for packing.
    """
    at_risk_pct  = 0.50 if is_picking else 0.75
    critical_pct = 0.75 if is_picking else 1.0

    order_code  = str(row.get("shipmentordercode", ""))
    is_dl       = (any(kw in str(row["clientname"]).lower() for kw in DEADLINE_CLIENTS)
                   or order_code.upper().startswith("AMZ")
                   or order_code.startswith("70"))

    if is_dl:
        # Deadline is 7:30 PM on the allocation day — if that day has passed, order is Past SLA
        try:
            alloc_date = pd.Timestamp(row[ref_col]).date()
        except Exception:
            alloc_date = now.date()
        deadline_dt      = tz.localize(datetime.combine(alloc_date, HARD_DEADLINE))
        remaining        = (deadline_dt - now).total_seconds() / 3600
        workday_start_dt = tz.localize(datetime.combine(alloc_date, WORKDAY_START))
        elapsed  = max(0.0, (now - workday_start_dt).total_seconds() / 3600)
        score, level, status = _urgency(elapsed, D2C_SLA_HRS, is_deadline=True, remaining_hrs=remaining)
        sla_type = "Hard Deadline (7:30 PM)"
    else:
        elapsed  = _calendar_hours_elapsed(row[ref_col], now, tz)
        score, level, status = _urgency(elapsed, D2C_SLA_HRS,
                                        at_risk_pct=at_risk_pct, critical_pct=critical_pct)
        sla_type = "24hr SLA"

    return score, level, status, sla_type


def _d2b_urgency(row, now, tz, sla_hrs, is_picking=False):
    """
    D2B urgency — pure rolling SLA from AllocationDate (working hours only).
    is_picking=True applies tighter thresholds (50%/75%) to leave room for packing.
    """
    at_risk_pct  = 0.50 if is_picking else 0.75
    critical_pct = 0.75 if is_picking else 1.0
    elapsed = _calendar_hours_elapsed(row["allocationdate"], now, tz)
    score, level, status = _urgency(elapsed, sla_hrs,
                                    at_risk_pct=at_risk_pct, critical_pct=critical_pct)
    return score, level, status, f"{sla_hrs}hr SLA"


def _age_label(allocation_dt, now):
    """
    Age as calendar days: today - allocation date of the order.
    e.g. allocated today → '0d', allocated yesterday → '1d'
    """
    try:
        if pd.isna(allocation_dt):
            return ""
        alloc_date = pd.Timestamp(allocation_dt).date()
        days = (now.date() - alloc_date).days
        return f"{max(days, 0)}d"
    except Exception:
        return ""


def apply_urgency(df, urgency_fn, now, tz):
    if df.empty:
        df["UrgencyScore"] = pd.Series(dtype=float)
        df["UrgencyLevel"] = pd.Series(dtype=str)
        df["TimeStatus"]   = pd.Series(dtype=str)
        df["SLAType"]      = pd.Series(dtype=str)
        df["AgeLabel"]     = pd.Series(dtype=str)
        return df
    results = df.apply(lambda r: urgency_fn(r, now, tz), axis=1)
    result_df = pd.DataFrame(
        results.tolist(),
        index=df.index,
        columns=["UrgencyScore", "UrgencyLevel", "TimeStatus", "SLAType"]
    )
    df = pd.concat([df, result_df], axis=1)

    # Age = working hours elapsed since allocation date (order creation).
    # Fall back to pickingcompletedat only if allocationdate is not available.
    if "allocationdate" in df.columns:
        age_col = "allocationdate"
    elif "pickingcompletedat" in df.columns:
        age_col = "pickingcompletedat"
    else:
        age_col = None

    if age_col:
        df["AgeLabel"] = df[age_col].apply(
            lambda t: _age_label(t, now)
        )
    return df


# ──────────────────────────────────────────────────────────────────────────────
# SORTING & WRITING
# ──────────────────────────────────────────────────────────────────────────────

def sort_queue(df):
    """
    Sort order:
      1. Urgency level  CRITICAL → AT RISK → ON TRACK
      2. Client priority  1 → 99
      3. Urgency score   highest first (most overdue at top)
    """
    rank = {"Past SLA": 0, "Breaching SLA": 1, "On Track": 2}
    df["_rank"] = df["UrgencyLevel"].map(rank).fillna(3)
    df = (
        df.sort_values(["_rank", "ClientPriority", "UrgencyScore"],
                       ascending=[True, True, False])
          .drop(columns=["_rank"])
          .reset_index(drop=True)
    )
    return df


DISPLAY_COLUMNS = {
    "taskid":             "Task ID",
    "shipmentorderid":    "Order ID",
    "shipmentordercode":  "Order Code",
    "clientname":         "Client Name",
    "clientdisplayname":  "Client Display Name",
    "waveno":             "Wave No",
    "warehouseid":        "Warehouse ID",
    "pickingcompletedat": "Picked At",
    "allocationdate":     "Allocation Date",
    "packingstatus":      "Packing Status",
    "pickingstatus":      "Picking Status",
    "pickingtype":        "Picking Type",
    "PackToday":          "Pack Today",
    "alert":              "Alert",
    "ordertype":          "Order Type",
    "orderstatus":        "Order Status",
    "pickedat":           "Picked At",
    "packedat":           "Packed At",
    "activitytime":       "Activity Time",
    "tasksdonetoday":     "Tasks Done Today",
    "totaltasks":         "Total Tasks",
    "totalcompleted":     "Total Completed",
    "activitytype":       "Activity Type",
    "completionstatus":   "Completion Status",
    "agehrs":             "Age (hrs)",
    "AgeLabel":           "Age",
    "ClientPriority":     "Client Priority",
    "UrgencyScore":       "Urgency Score",
    "UrgencyLevel":       "Urgency Level",
    "TimeStatus":         "Time Status",
    "SLAType":            "SLA Type",
    "LastRefreshed":      "Last Refreshed",
    "workdate":           "Date",
    "d2c_picked":         "D2C Picked",
    "d2c_packed":         "D2C Packed",
    "spd_picked":         "SPD Picked",
    "spd_packed":         "SPD Packed",
    "ltl_picked":         "LTL Picked",
    "ltl_packed":         "LTL Packed",
    "TotalPicked":        "Total Picked",
    "TotalPacked":        "Total Packed",
    "orderstatus":        "Status",
    "ordertype":          "Order Type",
    "allocationdate":     "Allocation Date",
    "picktaskcreatedat":  "Pick Task Created",
}


def build_queue(df, urgency_fn, priority_df, now, tz, is_monday=False, suppress_p4=False, is_packing=False):
    """
    Attach client priority, compute urgency, optionally suppress Monday P4,
    sort, and timestamp.
    is_packing=True adds a 'Pack Today' flag for Priority 1 clients.
    """
    df["ClientPriority"] = df["clientname"].apply(lambda n: match_priority(n, priority_df))

    if suppress_p4 and is_monday:
        before = len(df)
        df = df[df["ClientPriority"] != 4].copy()
        logger.info(f"    Monday rule: suppressed {before - len(df)} Priority-4 rows")

    if is_packing:
        df["PackToday"] = df["ClientPriority"].apply(
            lambda p: "✅ Pack Today" if p == 1 else ""
        )

    df = apply_urgency(df, urgency_fn, now, tz)
    df = sort_queue(df)
    df["LastRefreshed"] = now.strftime("%Y-%m-%d %H:%M:%S %Z")
    return df


# ──────────────────────────────────────────────────────────────────────────────
# HTML DASHBOARD GENERATOR
# ──────────────────────────────────────────────────────────────────────────────

def _generate_html(d2c_pack, d2c_pick, spd_pack, spd_pick,
                   ltl_pack, ltl_pick, ltl_nopack, today_df, hist_df,
                   open_shortage_df, hourly_df, baseline_df,
                   on_hold_df, now, filepath):
    """Generate a BI-style HTML dashboard: KPIs, pivot summaries, charts, detail tables."""
    import html as _html, json

    REFRESH_SECS = 300

    def esc(v):
        if v is None or (isinstance(v, float) and pd.isna(v)): return ""
        return _html.escape(str(v))

    def _dedup_orders(df):
        """Deduplicate to one row per order, keeping worst urgency level."""
        if df.empty or "shipmentordercode" not in df.columns: return df
        rank = {"Past SLA": 0, "Breaching SLA": 1, "On Track": 2}
        d = df.copy()
        d["_r"] = d.get("UrgencyLevel", pd.Series([""] * len(d))).map(rank).fillna(3)
        return (d.sort_values("_r").drop_duplicates("shipmentordercode", keep="first")
                 .drop(columns=["_r"]).reset_index(drop=True))

    def ocnt(df, col=None, val=None):
        """Count distinct orders, optionally filtered by col==val."""
        d = _dedup_orders(df)
        if d.empty: return 0
        if col and val: d = d[d[col] == val]
        return len(d)

    def cnt(df, col, val):
        if df.empty or col not in df.columns: return 0
        return int((df[col] == val).sum())

    def badge(level):
        c = {"Past SLA":"#dc2626","Breaching SLA":"#d97706","On Track":"#16a34a"}.get(str(level),"#6b7280")
        return f'<span class="badge" style="background:{c};color:#fff">{esc(level)}</span>'

    def row_bg(level):
        return {"Past SLA":"background:rgba(220,38,38,0.14);",
                "Breaching SLA":"background:rgba(217,119,6,0.14);",
                "On Track":"background:rgba(22,163,74,0.07);"}.get(str(level),"")

    def kpi(val, lbl, color="#3b82f6", sub="", onclick=""):
        sub_h = f'<div class="kpi-sub">{esc(sub)}</div>' if sub else ""
        extra = ' class="kpi-card clickable" onclick="'+onclick+'"' if onclick else ' class="kpi-card"'
        return (f'<div{extra} style="border-top:3px solid {color}">'
                f'<div class="kpi-val" style="color:{color}">{esc(str(val))}</div>'
                f'<div class="kpi-lbl">{esc(lbl)}</div>{sub_h}</div>')

    def tbl(df, cols, urgency_col="UrgencyLevel", max_rows=500):
        if df.empty: return '<p class="empty">No records.</p>'
        vis = [c for c in cols if c in df.columns]
        hdr = "".join(f"<th>{esc(DISPLAY_COLUMNS.get(c,c))}</th>" for c in vis)
        rows = []
        for _, r in df.head(max_rows).iterrows():
            lvl = r.get(urgency_col,"") if urgency_col else ""
            cells = []
            for c in vis:
                v = r.get(c,"")
                if c == urgency_col: cells.append(f"<td>{badge(v)}</td>")
                elif c == "PackToday" and str(v).startswith("\u2705"):
                    cells.append('<td><span class="badge" style="background:#0ea5e9;color:#fff">Pack Today</span></td>')
                elif c == "pickingtype" and str(v) == "Locus (Robot)":
                    cells.append('<td><span class="badge" style="background:#8b5cf6;color:#fff">Locus</span></td>')
                else: cells.append(f"<td>{esc(v)}</td>")
            rows.append(f'<tr style="{row_bg(lvl)}">{"".join(cells)}</tr>')
        note = f'<p class="table-note">Showing top {max_rows} of {len(df)}</p>' if len(df) > max_rows else ""
        return (f'<div class="tbl-wrap"><table class="qtable"><thead><tr>{hdr}</tr></thead>'
                f'<tbody>{"".join(rows)}</tbody></table></div>{note}')

    def client_pivot(df, label=""):
        if df.empty or "clientname" not in df.columns: return '<p class="empty">No records.</p>'
        # Deduplicate to order level before counting
        dd = _dedup_orders(df)
        grp = (dd.groupby("clientname", sort=False)
               .agg(Priority=("ClientPriority","first"), Total=("shipmentordercode","nunique"),
                    PastSLA=("UrgencyLevel", lambda x: (x=="Past SLA").sum()),
                    Breaching=("UrgencyLevel", lambda x: (x=="Breaching SLA").sum()),
                    OnTrack=("UrgencyLevel", lambda x: (x=="On Track").sum()))
               .sort_values(["Priority","PastSLA","Breaching"], ascending=[True,False,False])
               .reset_index())
        hdr = "<tr><th>Client</th><th>Pri</th><th>Total</th><th>Past SLA</th><th>Breaching</th><th>On Track</th></tr>"
        rows = []
        for _, r in grp.iterrows():
            ps = f'<span style="color:#dc2626;font-weight:700">{int(r.PastSLA)}</span>' if r.PastSLA > 0 else "0"
            br = f'<span style="color:#d97706;font-weight:700">{int(r.Breaching)}</span>' if r.Breaching > 0 else "0"
            rows.append(f"<tr><td>{esc(r.clientname)}</td><td>{int(r.Priority)}</td>"
                        f"<td>{int(r.Total)}</td><td>{ps}</td><td>{br}</td><td>{int(r.OnTrack)}</td></tr>")
        title = f'<p class="pivot-title">{esc(label)}</p>' if label else ""
        return (f'{title}<div class="tbl-wrap"><table class="qtable"><thead>{hdr}</thead>'
                f'<tbody>{"".join(rows)}</tbody></table></div>')

    def urgency_chart(pk_df, pa_df):
        """Horizontal stacked bar: Picking vs Packing, coloured by urgency tier."""
        lbl     = json.dumps(["Picking Queue", "Packing Queue"])
        past    = json.dumps([ocnt(pk_df,"UrgencyLevel","Past SLA"),    ocnt(pa_df,"UrgencyLevel","Past SLA")])
        breach  = json.dumps([ocnt(pk_df,"UrgencyLevel","Breaching SLA"),ocnt(pa_df,"UrgencyLevel","Breaching SLA")])
        ontrack = json.dumps([ocnt(pk_df,"UrgencyLevel","On Track"),     ocnt(pa_df,"UrgencyLevel","On Track")])
        js = (
            "(function(){"
            "var ctx=document.getElementById('urgBar').getContext('2d');"
            "new Chart(ctx,{"
              "type:'bar',"
              "data:{labels:LBL,datasets:["
                "{label:'Past SLA',data:PAST,backgroundColor:'rgba(220,38,38,0.82)',borderRadius:3},"
                "{label:'Breaching SLA',data:BREACH,backgroundColor:'rgba(217,119,6,0.82)',borderRadius:3},"
                "{label:'On Track',data:ONTRACK,backgroundColor:'rgba(22,163,74,0.75)',borderRadius:3}"
              "]},"
              "options:{"
                "indexAxis:'y',responsive:true,"
                "plugins:{"
                  "legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:11}}},"
                  "tooltip:{callbacks:{label:function(c){return c.dataset.label+': '+c.raw+' orders';}}}"
                "},"
                "scales:{"
                  "x:{stacked:true,ticks:{color:'#64748b'},grid:{color:'rgba(0,0,0,0.06)'},beginAtZero:true},"
                  "y:{stacked:true,ticks:{color:'#94a3b8',font:{size:12}},grid:{display:false}}"
                "}"
              "}"
            "});})();"
        )
        js = js.replace("LBL", lbl).replace("PAST", past).replace("BREACH", breach).replace("ONTRACK", ontrack)
        return (f'<div class="chart-box wide"><div class="chart-title">Urgency Breakdown</div>'
                f'<canvas id="urgBar" height="110"></canvas></div>'
                f'<script>{js}</script>')

    def hourly_section(hdf, bdf=None):
        """Client dropdown + hourly breakdown chart for today with historical baseline."""
        if hdf.empty:
            return '<p class="empty">No hourly data yet for today.</p>'
        clients = sorted(hdf["clientname"].dropna().unique().tolist())
        opts = '<option value="__all__">All Clients</option>' + "".join(
            f'<option value="{esc(c)}">{esc(c)}</option>' for c in clients
        )
        # Serialize today's data
        rows = hdf[["hour","activitytype","clientname","orders"]].copy()
        rows["hour"] = pd.to_numeric(rows["hour"], errors="coerce").fillna(0).astype(int)
        rows["orders"] = pd.to_numeric(rows["orders"], errors="coerce").fillna(0).astype(int)
        HOUR_START = 7
        raw = json.dumps(rows.rename(columns={"hour":"h","activitytype":"t","clientname":"c","orders":"n"}).to_dict("records"))
        hour_labels = json.dumps([f"{h:02d}:00" for h in range(HOUR_START, 24)])
        n_hours = 24 - HOUR_START
        # Build baseline arrays for hours 7–23 only
        bl_pk = [0] * n_hours
        bl_pa = [0] * n_hours
        if bdf is not None and not bdf.empty:
            bdf2 = bdf.copy()
            bdf2["hour"] = pd.to_numeric(bdf2["hour"], errors="coerce").fillna(0).astype(int)
            bdf2["max_orders"] = pd.to_numeric(bdf2["max_orders"], errors="coerce").fillna(0).astype(int)
            for _, r in bdf2.iterrows():
                h = int(r["hour"])
                if HOUR_START <= h < 24:
                    idx = h - HOUR_START
                    if str(r.get("activitytype","")).lower() == "picking":
                        bl_pk[idx] = int(r["max_orders"])
                    else:
                        bl_pa[idx] = int(r["max_orders"])
        baseline_pk = json.dumps(bl_pk)
        baseline_pa = json.dumps(bl_pa)
        hour_start = HOUR_START
        return f"""
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
  <div class="section-title" style="margin:0">Today \u2014 Hourly Breakdown</div>
  <select id="clientSel" onchange="updateHourly(this.value)"
    style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;border-radius:6px;padding:.3rem .7rem;font-size:.82rem;cursor:pointer">
    {opts}
  </select>
  <span style="font-size:.75rem;color:#64748b">&#9643; Dashed = 45-day weekday 90th percentile target</span>
</div>
<div class="chart-box wide" style="margin-bottom:1rem;height:300px;position:relative">
  <canvas id="hourlyBar"></canvas>
</div>
<script>
(function(){{
  var RAW = {raw};
  var HLBLS = {hour_labels};
  var BL_PK = {baseline_pk};
  var BL_PA = {baseline_pa};
  var HOUR_START = {hour_start};
  var hourlyChart = null;

  function agg(client) {{
    var data = (client === '__all__') ? RAW : RAW.filter(function(d){{ return d.c === client; }});
    var n = 24 - HOUR_START;
    var pk = new Array(n).fill(0);
    var pa = new Array(n).fill(0);
    data.forEach(function(d) {{
      var i = d.h - HOUR_START;
      if (i >= 0 && i < n) {{
        if (d.t === 'Picking') pk[i] += d.n;
        else pa[i] += d.n;
      }}
    }});
    return {{pk: pk, pa: pa}};
  }}

  window.updateHourly = function(client) {{
    var v = agg(client);
    if (hourlyChart) {{
      hourlyChart.data.datasets[0].data = v.pk;
      hourlyChart.data.datasets[1].data = v.pa;
      hourlyChart.update();
    }}
  }};

  if (window.ChartDataLabels) {{ Chart.register(ChartDataLabels); }}
  var v0 = agg('__all__');
  var ctx = document.getElementById('hourlyBar').getContext('2d');
  hourlyChart = new Chart(ctx, {{
    type: 'line',
    data: {{
      labels: HLBLS,
      datasets: [
        {{label:'Picked', data:v0.pk, borderColor:'rgba(34,197,94,1)', backgroundColor:'rgba(34,197,94,0.1)',
          borderWidth:2.5, pointRadius:4, pointBackgroundColor:'rgba(34,197,94,1)', tension:0.3, fill:true}},
        {{label:'Packed', data:v0.pa, borderColor:'rgba(59,130,246,1)', backgroundColor:'rgba(59,130,246,0.1)',
          borderWidth:2.5, pointRadius:4, pointBackgroundColor:'rgba(59,130,246,1)', tension:0.3, fill:true}},
        {{label:'Target Pick (45d p90)', data:BL_PK, borderColor:'rgba(34,197,94,0.45)',
          backgroundColor:'transparent', borderWidth:1.5, borderDash:[5,4], pointRadius:2,
          pointBackgroundColor:'rgba(34,197,94,0.45)', tension:0.3}},
        {{label:'Target Pack (45d p90)', data:BL_PA, borderColor:'rgba(59,130,246,0.45)',
          backgroundColor:'transparent', borderWidth:1.5, borderDash:[5,4], pointRadius:2,
          pointBackgroundColor:'rgba(59,130,246,0.45)', tension:0.3}}
      ]
    }},
    options: {{
      responsive: true,
      maintainAspectRatio: false,
      interaction: {{mode:'index', intersect:false}},
      plugins: {{
        legend: {{labels: {{color:'#64748b', boxWidth:12, font:{{size:11}}}}}},
        datalabels: {{
          display: function(ctx) {{ return ctx.datasetIndex < 2 && ctx.raw > 0; }},
          anchor: 'top',
          align: 'top',
          color: '#334155',
          font: {{size:9, weight:'600'}},
          formatter: function(value) {{ return value; }},
          offset: 2
        }}
      }},
      scales: {{
        x: {{ticks:{{color:'#64748b',font:{{size:9}}}}, grid:{{color:'rgba(0,0,0,0.06)'}}}},
        y: {{ticks:{{color:'#64748b',font:{{size:10}}}}, grid:{{color:'rgba(0,0,0,0.06)'}}, beginAtZero:true}}
      }}
    }}
  }});
}})();
</script>"""

    def _vol_adj_targets(df_daily):
        """
        Compute volume-adjusted pick/pack targets from historical data.
        Uses days OLDER than the last 15 (the baseline window: days 16-60).
        Baseline = p75 efficiency rate (picks / daily_allocated) on weekdays
                   with sufficient volume.  Returns (eff_pick, eff_pack) floats,
                   or (None, None) if not enough data.
        Target for a display day = efficiency × that day's DailyAllocated.
        This is "fair" because high-volume days get a higher absolute target.
        """
        for col in ["totalpicked", "totalpacked", "dailyallocated"]:
            if col not in df_daily.columns:
                df_daily[col] = 0
            df_daily[col] = pd.to_numeric(df_daily[col], errors="coerce").fillna(0)
        all_sorted = df_daily.sort_values("workdate")
        baseline = all_sorted.iloc[:-15] if len(all_sorted) > 15 else pd.DataFrame()
        if baseline.empty:
            return None, None
        bl = baseline.copy()
        bl["_dow"] = pd.to_datetime(bl["workdate"], errors="coerce").dt.dayofweek  # 0=Mon 6=Sun
        bl = bl[(bl["_dow"] < 5) & (bl["dailyallocated"] > 30)]   # weekdays, min 30 allocations
        if len(bl) < 5:
            return None, None
        eff_pick = (bl["totalpicked"] / bl["dailyallocated"]).quantile(0.75)
        eff_pack = (bl["totalpacked"] / bl["dailyallocated"]).quantile(0.75)
        return float(eff_pick), float(eff_pack)

    def trend_chart(df):
        if df.empty: return '<p class="empty">No history data.</p>'
        d = df.copy(); d["workdate"] = d["workdate"].astype(str)
        daily = d[~d["workdate"].str.contains(" ")].sort_values("workdate").copy()
        if daily.empty: return '<p class="empty">No daily history yet.</p>'

        # Compute fair baselines from older history, display last 15 days
        eff_pk, eff_pa = _vol_adj_targets(daily)
        display = daily.tail(15).copy()

        lbl = json.dumps(display["workdate"].tolist())
        pk  = json.dumps(pd.to_numeric(display.get("TotalPicked",  display.get("totalpicked",  0)), errors="coerce").fillna(0).astype(int).tolist())
        pa  = json.dumps(pd.to_numeric(display.get("TotalPacked",  display.get("totalpacked",  0)), errors="coerce").fillna(0).astype(int).tolist())
        d2c = json.dumps(pd.to_numeric(display.get("d2c_picked", 0), errors="coerce").fillna(0).astype(int).tolist())
        spd = json.dumps(pd.to_numeric(display.get("spd_picked", 0), errors="coerce").fillna(0).astype(int).tolist())
        ltl = json.dumps(pd.to_numeric(display.get("ltl_picked", 0), errors="coerce").fillna(0).astype(int).tolist())

        def _tgt_series(eff):
            if eff is None: return "[]"
            allocs = pd.to_numeric(display.get("dailyallocated", 0), errors="coerce").fillna(0)
            vals = [round(eff * a) if a > 30 else None for a in allocs]
            return json.dumps(vals)

        tpk = _tgt_series(eff_pk)
        tpa = _tgt_series(eff_pa)
        has_tgt = eff_pk is not None
        eff_pct = f"{eff_pk:.0%}" if eff_pk else ""
        tgt_note = f' <span style="font-size:0.75rem;color:#64748b">(target = {eff_pct} of daily volume, p75 of last 45d weekdays)</span>' if has_tgt else ""

        return f"""
<div class="chart-row">
  <div class="chart-box wide">
    <div class="chart-title">Daily Picked vs Packed \u2014 15 Day Trend{tgt_note}</div>
    <canvas id="tMain" height="240"></canvas>
  </div>
  <div class="chart-box">
    <div class="chart-title">Picked by Order Type</div>
    <canvas id="tType" height="240"></canvas>
  </div>
</div>
<script>(function(){{
  var L={lbl};
  var tpk={tpk}, tpa={tpa};
  var mainDs=[
    {{label:"Picked",data:{pk},borderColor:"#22c55e",backgroundColor:"rgba(34,197,94,0.1)",tension:0.3,fill:true,pointRadius:3}},
    {{label:"Packed",data:{pa},borderColor:"#3b82f6",backgroundColor:"rgba(59,130,246,0.1)",tension:0.3,fill:true,pointRadius:3}}
  ];
  if(tpk.length){{
    mainDs.push({{label:"Target Pick",data:tpk,borderColor:"rgba(34,197,94,0.5)",borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false,tension:0}});
    mainDs.push({{label:"Target Pack",data:tpa,borderColor:"rgba(59,130,246,0.5)",borderDash:[6,4],borderWidth:1.5,pointRadius:0,fill:false,tension:0}});
  }}
  new Chart(document.getElementById("tMain").getContext("2d"),{{type:"line",
    data:{{labels:L,datasets:mainDs}},
    options:{{responsive:true,interaction:{{mode:"index",intersect:false}},
      plugins:{{legend:{{labels:{{color:"#94a3b8",boxWidth:12}}}}}},
      scales:{{x:{{ticks:{{color:"#64748b",maxRotation:45,font:{{size:10}}}},grid:{{color:"rgba(0,0,0,0.06)"}}}},
               y:{{ticks:{{color:"#64748b"}},grid:{{color:"rgba(0,0,0,0.06)"}},beginAtZero:true}}}}
    }}}});
  new Chart(document.getElementById("tType").getContext("2d"),{{type:"bar",
    data:{{labels:L,datasets:[
      {{label:"D2C",data:{d2c},backgroundColor:"rgba(139,92,246,0.7)",stack:"s"}},
      {{label:"SPD",data:{spd},backgroundColor:"rgba(14,165,233,0.7)",stack:"s"}},
      {{label:"LTL",data:{ltl},backgroundColor:"rgba(249,115,22,0.7)",stack:"s"}}
    ]}},options:{{responsive:true,interaction:{{mode:"index",intersect:false}},
      plugins:{{legend:{{labels:{{color:"#94a3b8"}}}}}},
      scales:{{x:{{stacked:true,ticks:{{color:"#64748b",maxRotation:45,font:{{size:10}}}},grid:{{color:"rgba(0,0,0,0.06)"}}}},
               y:{{stacked:true,ticks:{{color:"#64748b"}},grid:{{color:"rgba(0,0,0,0.06)"}},beginAtZero:true}}}}
    }}}});
}})();</script>"""

    def today_bar(df):
        if df.empty or "activitytype" not in df.columns: return ""
        def ot(sub):
            m = {}
            for v in sub.get("ordertype", pd.Series([], dtype=str)):
                k = "D2C" if "D2C" in str(v).upper() else ("SPD" if "SPD" in str(v).upper() else "LTL")
                m[k] = m.get(k,0)+1
            return m
        pk = ot(df[df["activitytype"]=="picking"]); pa = ot(df[df["activitytype"]=="packing"])
        keys = sorted(set(pk)|set(pa))
        if not keys: return ""
        lbl = json.dumps(keys)
        pkv = json.dumps([pk.get(k,0) for k in keys])
        pav = json.dumps([pa.get(k,0) for k in keys])
        return (f'<div class="chart-box"><div class="chart-title">Today \u2014 Picked & Packed by Order Type</div>'
                f'<canvas id="todayBar" height="220"></canvas></div>'
                f'<script>(function(){{'
                f'new Chart(document.getElementById("todayBar").getContext("2d"),{{type:"bar",'
                f'data:{{labels:{lbl},datasets:[{{label:"Picked",data:{pkv},backgroundColor:"rgba(34,197,94,0.75)",borderRadius:4}},'
                f'{{label:"Packed",data:{pav},backgroundColor:"rgba(59,130,246,0.75)",borderRadius:4}}]}},'
                f'options:{{responsive:true,interaction:{{mode:"index",intersect:false}},'
                f'plugins:{{legend:{{labels:{{color:"#94a3b8"}}}}}},'
                f'scales:{{x:{{ticks:{{color:"#64748b"}},grid:{{color:"rgba(0,0,0,0.06)"}}}},'
                f'y:{{ticks:{{color:"#64748b"}},grid:{{color:"rgba(0,0,0,0.06)"}},beginAtZero:true}}}}}}}}}})();</script>')

    # ── Aggregate ─────────────────────────────────────────────────────────────
    frames_pick = [f for f in [d2c_pick,spd_pick,ltl_pick] if not f.empty]
    frames_pack = [f for f in [d2c_pack,spd_pack,ltl_pack] if not f.empty]
    all_pick = pd.concat(frames_pick,ignore_index=True) if frames_pick else pd.DataFrame()
    all_pack = pd.concat(frames_pack,ignore_index=True) if frames_pack else pd.DataFrame()

    # ── Exclude ON HOLD orders from SLA queues ────────────────────────────────
    _oh_codes = set(on_hold_df["shipmentordercode"].str.upper()) if not on_hold_df.empty else set()
    if _oh_codes and "shipmentordercode" in all_pick.columns:
        all_pick = all_pick[~all_pick["shipmentordercode"].str.upper().isin(_oh_codes)]
    if _oh_codes and "shipmentordercode" in all_pack.columns:
        all_pack = all_pack[~all_pack["shipmentordercode"].str.upper().isin(_oh_codes)]

    tot_pick=ocnt(all_pick); tot_pack=ocnt(all_pack)
    pp=ocnt(all_pick,"UrgencyLevel","Past SLA");    bp=ocnt(all_pick,"UrgencyLevel","Breaching SLA")
    ppa=ocnt(all_pack,"UrgencyLevel","Past SLA");   bpa=ocnt(all_pack,"UrgencyLevel","Breaching SLA")

    act = "activitytype"   if "activitytype"   in today_df.columns else None
    cmp = "completionstatus" if "completionstatus" in today_df.columns else None
    ot  = "ordertype"        if "ordertype"        in today_df.columns else None

    def _td(df, activity, otype=None):
        """Count today rows for a given activity type, optionally filtered by order type."""
        if not act or df.empty: return 0
        mask = df[act].str.lower() == activity.lower()
        if otype and ot:
            mask = mask & df[ot].str.upper().str.contains(otype.upper(), na=False)
        return int(mask.sum())

    def _td_cmp(df, status, otype=None):
        if not cmp or df.empty: return 0
        mask = df[cmp] == status
        if otype and ot:
            mask = mask & df[ot].str.upper().str.contains(otype.upper(), na=False)
        return int(mask.sum())

    td_pk   = _td(today_df, "Picking");   td_pa   = _td(today_df, "Packing")
    td_fp   = _td_cmp(today_df, "Fully Picked"); td_fa = _td_cmp(today_df, "Fully Packed")

    # Per order-type fully picked/packed counts
    td_pk_d2c = _td_cmp(today_df, "Fully Picked", "D2C"); td_pa_d2c = _td_cmp(today_df, "Fully Packed", "D2C")
    td_pk_spd = _td_cmp(today_df, "Fully Picked", "SPD"); td_pa_spd = _td_cmp(today_df, "Fully Packed", "SPD")
    td_pk_ltl = _td_cmp(today_df, "Fully Picked", "LTL"); td_pa_ltl = _td_cmp(today_df, "Fully Packed", "LTL")

    ts = now.strftime("%Y-%m-%d %H:%M %Z")

    # ── Column sets ───────────────────────────────────────────────────────────
    D2C_PK = ["clientname","ClientPriority","shipmentordercode","waveno","pickingtype","AgeLabel","pickingstatus","UrgencyLevel"]
    D2C_PA = ["clientname","ClientPriority","shipmentordercode","waveno","AgeLabel","packingstatus","UrgencyLevel"]
    D2B_PK = ["clientname","ClientPriority","shipmentordercode","waveno","AgeLabel","pickingstatus","UrgencyLevel"]
    D2B_PA = ["clientname","ClientPriority","shipmentordercode","waveno","AgeLabel","packingstatus","UrgencyLevel"]
    NP     = ["clientname","ClientPriority","shipmentordercode","waveno","AgeLabel","alert","UrgencyLevel"]
    TD     = ["shipmentordercode","ordertype","clientname","activitytype","completionstatus","tasksdonetoday","totaltasks","activitytime"]

    def mk_pick(df, lbl, td_pk=0, td_pa=0):
        return (f'<div class="kpi-row">'
                f'{kpi(ocnt(df),"Total Orders","#8b5cf6")}'
                f'{kpi(ocnt(df,"UrgencyLevel","Past SLA"),"Past SLA","#dc2626")}'
                f'{kpi(ocnt(df,"UrgencyLevel","Breaching SLA"),"Breaching SLA","#d97706")}'
                f'{kpi(ocnt(df,"UrgencyLevel","On Track"),"On Track","#16a34a")}'
                f'{kpi(td_pk,"Fully Picked Today","#22c55e")}'
                f'{kpi(td_pa,"Fully Packed Today","#3b82f6")}'
                f'</div>{client_pivot(df,lbl)}'
                f'<div class="section-title" style="margin-top:1.2rem">Full Queue</div>{tbl(_dedup_orders(df),D2B_PK)}')

    def mk_pack(df, lbl, td_pk=0, td_pa=0):
        return (f'<div class="kpi-row">'
                f'{kpi(ocnt(df),"Total Orders","#0ea5e9")}'
                f'{kpi(ocnt(df,"UrgencyLevel","Past SLA"),"Past SLA","#dc2626")}'
                f'{kpi(ocnt(df,"UrgencyLevel","Breaching SLA"),"Breaching SLA","#d97706")}'
                f'{kpi(ocnt(df,"UrgencyLevel","On Track"),"On Track","#16a34a")}'
                f'{kpi(td_pk,"Fully Picked Today","#22c55e")}'
                f'{kpi(td_pa,"Fully Packed Today","#3b82f6")}'
                f'</div>{client_pivot(df,lbl)}'
                f'<div class="section-title" style="margin-top:1.2rem">Full Queue</div>{tbl(_dedup_orders(df),D2B_PA)}')

    d2b_pk_all = pd.concat([f for f in [spd_pick,ltl_pick] if not f.empty],ignore_index=True) if any(not f.empty for f in [spd_pick,ltl_pick]) else pd.DataFrame()
    d2b_pa_all = pd.concat([f for f in [spd_pack,ltl_pack] if not f.empty],ignore_index=True) if any(not f.empty for f in [spd_pack,ltl_pack]) else pd.DataFrame()

    # ── Open & Shortage compute (must be before overview f-string) ────────────
    def _os_client_pivot(df, status_filter, label):
        sub = df[df["orderstatus"] == status_filter].copy() if not df.empty else df
        if sub.empty:
            return f'<p class="pivot-title">{label}</p><p class="empty">No records.</p>'
        grp = (sub.groupby("clientname", sort=False)
                  .agg(Total=("shipmentordercode", "nunique"))
                  .sort_values("Total", ascending=False)
                  .reset_index())
        hdr = "<tr><th>Client</th><th>Orders</th></tr>"
        rows = "".join(
            f"<tr><td>{esc(r.clientname)}</td><td><strong>{int(r.Total)}</strong></td></tr>"
            for _, r in grp.iterrows()
        )
        return (f'<p class="pivot-title">{label}</p>'
                f'<div class="tbl-wrap"><table class="qtable"><thead>{hdr}</thead>'
                f'<tbody>{rows}</tbody></table></div>')

    # open_shortage_df: simple Id/Code/ClientName/OrderStatus — no age calc needed

    n_open     = int(open_shortage_df[open_shortage_df["orderstatus"] == "Open"]["shipmentorderid"].nunique())     if not open_shortage_df.empty else 0
    n_shortage = int(open_shortage_df[open_shortage_df["orderstatus"] == "Shortage"]["shipmentorderid"].nunique()) if not open_shortage_df.empty else 0

    # ── KPI modal data ────────────────────────────────────────────────────────
    def _modal_data(df, cols, title):
        """Serialize df rows for JS modal. cols = list of (label, df_col)."""
        if df.empty: return {"title": title, "cols": [c[0] for c in cols], "rows": []}
        rows = []
        for _, r in _dedup_orders(df).iterrows() if "shipmentordercode" in df.columns else df.iterrows():
            rows.append([_html.escape(str(r.get(c[1], "") or "")) for c in cols])
        return {"title": title, "cols": [c[0] for c in cols], "rows": rows}

    _pick_cols = [("Order Code","shipmentordercode"),("Client","clientname"),("Urgency","UrgencyLevel"),("Age","AgeLabel"),("SLA","SLAStatus")]
    _pack_cols = _pick_cols
    _sla_cols  = [("Order Code","shipmentordercode"),("Client","clientname"),("Order Type","ordertype"),("Urgency","UrgencyLevel"),("Age","AgeLabel"),("SLA","SLAStatus")]
    _os_cols   = [("Order Code","shipmentordercode"),("Client","clientname"),("Status","orderstatus")]
    _td_cols   = [("Order Code","shipmentordercode"),("Client","clientname"),("Status","completionstatus")]

    _all_qs = pd.concat([f for f in [all_pick,all_pack] if not f.empty],ignore_index=True) if any(not f.empty for f in [all_pick,all_pack]) else pd.DataFrame()

    kpi_data = {
        "open":         _modal_data(open_shortage_df[open_shortage_df["orderstatus"]=="Open"]  if not open_shortage_df.empty else pd.DataFrame(), _os_cols,  "Open Orders"),
        "shortage":     _modal_data(open_shortage_df[open_shortage_df["orderstatus"]=="Shortage"] if not open_shortage_df.empty else pd.DataFrame(), _os_cols, "Shortage Orders"),
        "pending_pick": _modal_data(all_pick, _pick_cols, "Pending Pick"),
        "pending_pack": _modal_data(all_pack, _pack_cols, "Pending Pack"),
        "picked_today": _modal_data(today_df[today_df["completionstatus"]=="Fully Picked"] if not today_df.empty else pd.DataFrame(), _td_cols, "Fully Picked Today"),
        "packed_today": _modal_data(today_df[today_df["completionstatus"]=="Fully Packed"] if not today_df.empty else pd.DataFrame(), _td_cols, "Fully Packed Today"),
        "past_sla":     _modal_data(_all_qs[_all_qs["UrgencyLevel"]=="Past SLA"] if not _all_qs.empty else pd.DataFrame(), _sla_cols, "Past SLA — All Queues"),
        "breaching_sla":_modal_data(_all_qs[_all_qs["UrgencyLevel"]=="Breaching SLA"] if not _all_qs.empty else pd.DataFrame(), _sla_cols, "Breaching SLA — All Queues"),
    }
    kpi_data_json = json.dumps(kpi_data)

    # ── Tab content ───────────────────────────────────────────────────────────
    overview = f"""
<div class="section-title">Live Queue Snapshot</div>
<div class="kpi-row">
  {kpi(n_open,"Open Orders","#0ea5e9",onclick="showKpi('open')")}
  {kpi(n_shortage,"Shortage Orders","#dc2626",onclick="showKpi('shortage')")}
  {kpi(tot_pick,"Pending Pick (Orders)","#8b5cf6",onclick="showKpi('pending_pick')")}
  {kpi(td_fp,"Fully Picked Today","#22c55e",onclick="showKpi('picked_today')")}
  {kpi(tot_pack,"Pending Pack (Orders)","#0ea5e9",onclick="showKpi('pending_pack')")}
  {kpi(td_fa,"Fully Packed Today","#3b82f6",onclick="showKpi('packed_today')")}
  {kpi(pp+ppa,"Past SLA (All)","#dc2626",onclick="showKpi('past_sla')")}
  {kpi(bp+bpa,"Breaching SLA","#d97706",onclick="showKpi('breaching_sla')")}
</div>
<div style="margin-top:1.5rem">
  {hourly_section(hourly_df, baseline_df)}
</div>
<div class="section-title" style="margin-top:1.5rem">Picking \u2014 Client Summary</div>
<div class="pivot-row">
  <div class="pivot-col">{client_pivot(d2c_pick,"D2C Picking")}</div>
  <div class="pivot-col">{client_pivot(d2b_pk_all,"D2B Picking (SPD + LTL)")}</div>
</div>
<div class="section-title" style="margin-top:1.5rem">Packing \u2014 Client Summary</div>
<div class="pivot-row">
  <div class="pivot-col">{client_pivot(d2c_pack,"D2C Packing")}</div>
  <div class="pivot-col">{client_pivot(d2b_pa_all,"D2B Packing (SPD + LTL)")}</div>
</div>
<div class="section-title" style="margin-top:1.5rem">Open &amp; Shortage \u2014 Client Distribution</div>
<div class="pivot-row">
  <div class="pivot-col">{_os_client_pivot(open_shortage_df,"Open","Open Orders by Client")}</div>
  <div class="pivot-col">{_os_client_pivot(open_shortage_df,"Shortage","Shortage Orders by Client")}</div>
</div>"""

    today_tab = f"""
<div class="kpi-row">
  {kpi(td_pk,"Picked Today","#22c55e",f"{td_fp} fully picked")}{kpi(td_pa,"Packed Today","#3b82f6",f"{td_fa} fully packed")}
</div>
{today_bar(today_df)}
<div class="section-title" style="margin-top:1.2rem">Detail</div>
{tbl(today_df,TD,urgency_col="")}"""

    d2c_pk_tab = f"""
<div class="kpi-row">
  {kpi(ocnt(d2c_pick),"Pending Pick","#8b5cf6")}{kpi(ocnt(d2c_pick,"UrgencyLevel","Past SLA"),"Past SLA","#dc2626")}
  {kpi(ocnt(d2c_pick,"UrgencyLevel","Breaching SLA"),"Breaching SLA","#d97706")}{kpi(ocnt(d2c_pick,"UrgencyLevel","On Track"),"On Track","#16a34a")}
  {kpi(td_pk_d2c,"Fully Picked Today","#22c55e")}{kpi(ocnt(d2c_pick,"pickingtype","Locus (Robot)"),"Locus Tasks","#8b5cf6")}
</div>
{client_pivot(d2c_pick,"D2C Picking \u2014 by Client")}
<div class="section-title" style="margin-top:1.2rem">Full Queue</div>
{tbl(_dedup_orders(d2c_pick),D2C_PK)}"""

    d2c_pa_tab = f"""
<div class="kpi-row">
  {kpi(ocnt(d2c_pack),"Pending Pack","#0ea5e9")}{kpi(ocnt(d2c_pack,"UrgencyLevel","Past SLA"),"Past SLA","#dc2626")}
  {kpi(ocnt(d2c_pack,"UrgencyLevel","Breaching SLA"),"Breaching SLA","#d97706")}{kpi(ocnt(d2c_pack,"UrgencyLevel","On Track"),"On Track","#16a34a")}
  {kpi(td_pa_d2c,"Fully Packed Today","#3b82f6")}
</div>
{client_pivot(d2c_pack,"D2C Packing \u2014 by Client")}
<div class="section-title" style="margin-top:1.2rem">Full Queue</div>
{tbl(_dedup_orders(d2c_pack),D2C_PA)}"""

    nopack_tab = f"""
<div class="kpi-row">{kpi(ocnt(ltl_nopack),"LTL Orders \u2014 No Pack Task","#dc2626")}</div>
{client_pivot(ltl_nopack,"LTL No-Pack Alert")}
<div class="section-title" style="margin-top:1.2rem">Detail</div>
{tbl(_dedup_orders(ltl_nopack),NP)}"""

    def _on_hold_tab(df):
        if df.empty:
            return '<p class="empty" style="padding:2rem">No ON HOLD orders at this time.</p>'
        n = len(df)
        clients = df.groupby("clientname")["shipmentordercode"].nunique().reset_index()
        clients.columns = ["Client", "Orders"]
        clients = clients.sort_values("Orders", ascending=False)
        client_rows = "".join(
            f'<tr><td>{esc(r["Client"])}</td><td style="text-align:right;font-weight:600">{r["Orders"]}</td></tr>'
            for _, r in clients.iterrows()
        )
        cols = ["shipmentordercode","clientname","ordertype","allocationdate","UrgencyLevel","AgeLabel"]
        vis  = [c for c in cols if c in df.columns]
        hdrs = {"shipmentordercode":"Order Code","clientname":"Client","ordertype":"Order Type",
                "allocationdate":"Allocated","UrgencyLevel":"Was Urgency","AgeLabel":"Age"}
        detail_rows = "".join(
            "<tr>" + "".join(
                f'<td><span class="badge" style="background:#f59e0b;color:#fff">{esc(str(r.get(c,"") or ""))}</span></td>'
                if c == "UrgencyLevel" else
                f'<td>{esc(str(r.get(c,"") or ""))}</td>'
                for c in vis
            ) + "</tr>"
            for _, r in _dedup_orders(df).iterrows()
        )
        return f"""
<div class="kpi-row">
  {kpi(n, "Orders On Hold", "#f59e0b")}
</div>
<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;font-size:.82rem;color:#92400e">
  &#9888; These orders have been tagged <strong>ON HOLD</strong> in Logiwa by the CSM team.
  They are excluded from SLA calculations until the hold is removed.
</div>
<div class="section-title">By Client</div>
<table class="qtable" style="max-width:400px;margin-bottom:1.5rem">
  <thead><tr><th>Client</th><th style="text-align:right">Orders</th></tr></thead>
  <tbody>{client_rows}</tbody>
</table>
<div class="section-title">All On Hold Orders</div>
<div style="overflow-x:auto">
<table class="qtable" style="width:100%">
  <thead><tr>{"".join(f"<th>{hdrs.get(c,c)}</th>" for c in vis)}</tr></thead>
  <tbody>{detail_rows}</tbody>
</table>
</div>"""

    TABS = [
        ("ov",     "Overview",              overview,                                         None),
        ("d2cpk",  "D2C Picking",           d2c_pk_tab,                                       len(d2c_pick)),
        ("d2cpa",  "D2C Packing",           d2c_pa_tab,                                       len(d2c_pack)),
        ("spdpk",  "SPD Picking",           mk_pick(spd_pick,"SPD Picking",td_pk_spd,td_pa_spd), len(spd_pick)),
        ("spdpa",  "SPD Packing",           mk_pack(spd_pack,"SPD Packing",td_pk_spd,td_pa_spd), len(spd_pack)),
        ("ltlpk",  "LTL Picking",           mk_pick(ltl_pick,"LTL Picking",td_pk_ltl,td_pa_ltl), len(ltl_pick)),
        ("ltlpa",  "LTL Packing",           mk_pack(ltl_pack,"LTL Packing",td_pk_ltl,td_pa_ltl), len(ltl_pack)),
        ("ltlnp",  "LTL No-Pack \u26a0",    nopack_tab,                                       len(ltl_nopack)),
        ("onhold", "On Hold \U0001f6d1",    _on_hold_tab(on_hold_df),                         len(on_hold_df) if not on_hold_df.empty else 0),
        ("tr",     "Daily Trend",           trend_chart(hist_df),  None),
    ]

    def _nav_item(i, t):
        active = " active" if i == 0 else ""
        cnt_html = f'<span class="cnt">{t[3]}</span>' if t[3] is not None else ""
        return (f'<li class="nav-item"><a class="nav-link{active}" data-bs-toggle="tab" href="#{t[0]}">'
                f'{esc(t[1])}{cnt_html}</a></li>')
    nav = "".join(_nav_item(i, t) for i, t in enumerate(TABS))
    content = "".join(
        f'<div class="tab-pane fade{"  show active" if i==0 else ""}" id="{t[0]}">'
        f'<div class="tab-inner">{t[2]}</div></div>'
        for i,t in enumerate(TABS))

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WMS Dashboard</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#f1f5f9;color:#1e293b;font-family:"Segoe UI",system-ui,sans-serif;font-size:.875rem}}
.topbar{{background:#ffffff;border-bottom:1px solid #e2e8f0;padding:.6rem 1.4rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 1px 4px rgba(0,0,0,0.06)}}
.topbar h1{{font-size:1rem;font-weight:700;color:#0f172a}}
.topbar .meta{{color:#64748b;font-size:.8rem}} .topbar .meta strong{{color:#475569}}
#cd{{color:#16a34a;font-weight:700}}
.nav-tabs{{background:#ffffff;border-bottom:1px solid #e2e8f0;padding:0 1rem;overflow-x:auto;flex-wrap:nowrap;display:flex}}
.nav-tabs .nav-link{{color:#64748b;border:none;border-bottom:2px solid transparent;padding:.5rem .85rem;font-size:.8rem;white-space:nowrap}}
.nav-tabs .nav-link.active{{color:#1e293b;border-bottom-color:#3b82f6;background:transparent;font-weight:600}}
.nav-tabs .nav-link:hover{{color:#334155}}
.cnt{{background:#e2e8f0;color:#475569;font-size:.68rem;padding:.1em .45em;border-radius:10px;margin-left:.3rem}}
.tab-inner{{padding:1.4rem 1.2rem}}
.kpi-row{{display:flex;gap:.9rem;flex-wrap:wrap;margin-bottom:.8rem}}
.kpi-card{{background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:1.1rem 1.4rem;min-width:130px;flex:1;box-shadow:0 1px 3px rgba(0,0,0,0.05)}}
.kpi-card.clickable{{cursor:pointer;transition:box-shadow .15s,transform .1s}}
.kpi-card.clickable:hover{{box-shadow:0 4px 14px rgba(0,0,0,0.12);transform:translateY(-2px)}}
.kpi-val{{font-size:2.1rem;font-weight:800;line-height:1.1}}
.kpi-lbl{{font-size:.72rem;color:#64748b;margin-top:.3rem;text-transform:uppercase;letter-spacing:.06em}}
.kpi-sub{{font-size:.72rem;color:#94a3b8;margin-top:.2rem}}
.section-title{{font-size:.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.6rem;padding-bottom:.3rem;border-bottom:1px solid #e2e8f0}}
.chart-row{{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}}
.chart-box{{background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.2rem;flex:1;min-width:250px;box-shadow:0 1px 3px rgba(0,0,0,0.05)}}
.chart-box.wide{{flex:2;min-width:380px}}
.chart-title{{font-size:.73rem;font-weight:600;color:#64748b;margin-bottom:.6rem;text-transform:uppercase;letter-spacing:.05em}}
.pivot-row{{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}}
.pivot-col{{flex:1;min-width:280px}}
.pivot-title{{font-size:.73rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem}}
.tbl-wrap{{overflow-x:auto;border-radius:8px;border:1px solid #e2e8f0}}
.qtable{{width:100%;border-collapse:collapse;background:#ffffff}}
.qtable thead th{{background:#f8fafc;color:#64748b;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;padding:.5rem .65rem;border-bottom:1px solid #e2e8f0;white-space:nowrap;position:sticky;top:0}}
.qtable tbody td{{padding:.4rem .65rem;border-bottom:1px solid #f1f5f9;vertical-align:middle;white-space:nowrap;color:#334155}}
.qtable tbody tr:last-child td{{border-bottom:none}}
.qtable tbody tr:hover{{background:#f8fafc}}
.badge{{font-size:.69rem;font-weight:600;padding:.2em .5em;border-radius:4px}}
.empty{{color:#94a3b8;font-style:italic;padding:.6rem 0;font-size:.82rem}}
.table-note{{font-size:.7rem;color:#94a3b8;margin-top:.3rem;text-align:right}}
</style>
</head>
<body>
<div class="topbar">
  <div style="display:flex;align-items:center;gap:.85rem">
    <div style="line-height:1.2">
      <div style="font-size:1.2rem;font-weight:800;color:#1d4ed8;letter-spacing:-.02em">eShipper<span style="color:#0ea5e9">+</span></div>
      <div style="font-size:.75rem;font-weight:700;color:#334155;letter-spacing:.08em;text-transform:uppercase">WMS Dashboard</div>
    </div>
  </div>
  <div class="meta">Last updated: <strong>{ts}</strong>&nbsp;&nbsp;Refreshes in <strong><span id="cd"></span></strong></div>
</div>
<ul class="nav nav-tabs">{nav}</ul>
<div class="tab-content">{content}</div>
<div class="modal fade" id="kpiModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-xl modal-dialog-scrollable">
    <div class="modal-content" style="border:1px solid #e2e8f0">
      <div class="modal-header" style="background:#f8fafc;border-bottom:1px solid #e2e8f0;padding:.75rem 1rem">
        <h6 class="modal-title fw-bold" id="kpiModalTitle" style="color:#1e293b;font-size:.9rem"></h6>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body p-0" id="kpiModalBody"></div>
    </div>
  </div>
</div>
<script>
var KPI_DATA={kpi_data_json};
var _kpiState={{}};
function _renderKpiTable(key){{
  var d=KPI_DATA[key];
  var st=_kpiState[key]||{{col:-1,asc:true}};
  var urg={{"Past SLA":"#dc2626","Breaching SLA":"#d97706","On Track":"#16a34a"}};
  var rows=d.rows.slice();
  if(st.col>=0){{
    rows.sort(function(a,b){{
      var av=a[st.col]||'',bv=b[st.col]||'';
      var an=parseFloat(av),bn=parseFloat(bv);
      var cmp=(!isNaN(an)&&!isNaN(bn))?(an-bn):av.localeCompare(bv);
      return st.asc?cmp:-cmp;
    }});
  }}
  var th='<tr>'+d.cols.map(function(c,i){{
    var arrow=st.col===i?(st.asc?' ▲':' ▼'):'';
    return'<th data-col="'+i+'" style="cursor:pointer;user-select:none">'+c+arrow+'</th>';
  }}).join('')+'</tr>';
  var tb=rows.map(function(r){{
    var cells=r.map(function(v,i){{
      if(d.cols[i]==='Urgency'){{
        var col=urg[v]||'#64748b';
        return'<td><span class="badge" style="background:'+col+';color:#fff">'+v+'</span></td>';
      }}
      return'<td>'+v+'</td>';
    }}).join('');
    return'<tr>'+cells+'</tr>';
  }}).join('');
  document.getElementById('kpiModalBody').innerHTML=
    '<div style="overflow-x:auto"><table class="qtable" style="width:100%"><thead>'+th+'</thead><tbody>'+tb+'</tbody></table></div>';
  document.querySelectorAll('#kpiModalBody th[data-col]').forEach(function(th){{
    th.addEventListener('click',function(){{_sortKpi(key,parseInt(this.getAttribute('data-col')));}});
  }});
}}
function _sortKpi(key,col){{
  var st=_kpiState[key]||{{col:-1,asc:true}};
  _kpiState[key]={{col:col,asc:st.col===col?!st.asc:true}};
  _renderKpiTable(key);
}}
function showKpi(key){{
  var d=KPI_DATA[key];if(!d)return;
  document.getElementById('kpiModalTitle').textContent=d.title+' ('+d.rows.length+' orders)';
  _renderKpiTable(key);
  new bootstrap.Modal(document.getElementById('kpiModal')).show();
}}
var s={REFRESH_SECS};
function tick(){{s--;if(s<=0){{location.href=location.pathname+"?t="+Date.now();return;}}var m=Math.floor(s/60),sc=s%60;document.getElementById("cd").textContent=m+":"+(sc<10?"0":"")+sc;}}
setInterval(tick,1000);tick();
var k="wms_tab";var sv=localStorage.getItem(k);
if(sv){{var el=document.querySelector('[href="#'+sv+'"]');if(el)new bootstrap.Tab(el).show();}}
document.querySelectorAll('[data-bs-toggle="tab"]').forEach(function(el){{el.addEventListener("shown.bs.tab",function(e){{localStorage.setItem(k,e.target.getAttribute("href").replace("#",""));}});}});
</script>
</body></html>"""

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(html)
    return

    # ── dead code below — will be removed ─────────────────────────────────────
    import html as _html_old
    import json as _json_old

    REFRESH_SECS = 300

    def esc(v):
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return ""
        return _html.escape(str(v))

    def badge(level):
        c = {"Past SLA": "#dc2626", "Breaching SLA": "#d97706", "On Track": "#16a34a"}.get(str(level), "#6b7280")
        return f'<span class="badge" style="background:{c}">{esc(level)}</span>'

    def row_style(level):
        return {
            "Past SLA":     "background:rgba(220,38,38,0.15);",
            "Breaching SLA":"background:rgba(217,119,6,0.15);",
            "On Track":     "background:rgba(22,163,74,0.08);",
        }.get(str(level), "")

    def cards(df, label="Orders"):
        total    = len(df)
        past     = len(df[df["UrgencyLevel"] == "Past SLA"])     if "UrgencyLevel" in df.columns else 0
        breach   = len(df[df["UrgencyLevel"] == "Breaching SLA"]) if "UrgencyLevel" in df.columns else 0
        ontrack  = len(df[df["UrgencyLevel"] == "On Track"])     if "UrgencyLevel" in df.columns else 0
        return f"""
<div class="cards-row">
  <div class="card-box"><div class="card-val">{total}</div><div class="card-lbl">Total {label}</div></div>
  <div class="card-box danger"><div class="card-val">{past}</div><div class="card-lbl">Past SLA</div></div>
  <div class="card-box warning"><div class="card-val">{breach}</div><div class="card-lbl">Breaching SLA</div></div>
  <div class="card-box success"><div class="card-val">{ontrack}</div><div class="card-lbl">On Track</div></div>
</div>"""

    def queue_table(df, cols):
        if df.empty:
            return '<p class="empty-msg">No orders in queue.</p>'
        visible = [c for c in cols if c in df.columns]
        hdrs = "".join(f"<th>{esc(DISPLAY_COLUMNS.get(c, c))}</th>" for c in visible)
        rows_html = []
        for _, r in df.iterrows():
            lvl = r.get("UrgencyLevel", "")
            cells = []
            for c in visible:
                v = r.get(c, "")
                if c == "UrgencyLevel":
                    cells.append(f"<td>{badge(v)}</td>")
                elif c == "PackToday" and str(v).startswith("✅"):
                    cells.append('<td><span class="badge" style="background:#0ea5e9">Pack Today</span></td>')
                elif c == "pickingtype" and str(v) == "Locus (Robot)":
                    cells.append('<td><span class="badge" style="background:#8b5cf6">Locus</span></td>')
                else:
                    cells.append(f"<td>{esc(v)}</td>")
            rows_html.append(f'<tr style="{row_style(lvl)}">{"".join(cells)}</tr>')
        return f"""
<div class="tbl-wrap">
<table class="qtable">
<thead><tr>{hdrs}</tr></thead>
<tbody>{"".join(rows_html)}</tbody>
</table></div>"""

    # ── Today's progress summary ──────────────────────────────────────────────
    def today_section(df):
        if df.empty:
            return '<p class="empty-msg">No activity today yet.</p>'
        picked_total = len(df[df.get("activitytype", df.columns[0]) == "picking"]) if "activitytype" in df.columns else 0
        packed_total = len(df[df.get("activitytype", df.columns[0]) == "packing"]) if "activitytype" in df.columns else 0

        # Count fully done vs in progress
        fully_picked = len(df[df.get("completionstatus", "") == "Fully Picked"]) if "completionstatus" in df.columns else 0
        fully_packed = len(df[df.get("completionstatus", "") == "Fully Packed"]) if "completionstatus" in df.columns else 0

        cols = ["shipmentordercode", "ordertype", "clientname", "activitytype",
                "completionstatus", "tasksdonetoday", "totaltasks", "activitytime"]
        tbl = queue_table(df, cols)
        return f"""
<div class="cards-row" style="margin-bottom:1.5rem">
  <div class="card-box success"><div class="card-val">{picked_total}</div><div class="card-lbl">Picked Today</div></div>
  <div class="card-box" style="border-color:#0ea5e9"><div class="card-val">{packed_total}</div><div class="card-lbl">Packed Today</div></div>
  <div class="card-box"><div class="card-val">{fully_picked}</div><div class="card-lbl">Fully Picked</div></div>
  <div class="card-box"><div class="card-val">{fully_packed}</div><div class="card-lbl">Fully Packed</div></div>
</div>
{tbl}"""

    # ── Daily trend chart data ────────────────────────────────────────────────
    def trend_chart(df):
        if df.empty:
            return '<p class="empty-msg">No history data yet.</p>'
        df2 = df.copy()
        df2["workdate"] = df2["workdate"].astype(str)
        df2 = df2.sort_values("workdate")
        # Use daily rows only (date-only format) for the chart
        daily = df2[~df2["workdate"].str.contains(" ")].copy()
        if daily.empty:
            daily = df2
        labels   = json.dumps(daily["workdate"].tolist())
        picked   = json.dumps(pd.to_numeric(daily.get("TotalPicked", daily.get("totalpicked", 0)), errors="coerce").fillna(0).astype(int).tolist())
        packed   = json.dumps(pd.to_numeric(daily.get("TotalPacked", daily.get("totalpacked", 0)), errors="coerce").fillna(0).astype(int).tolist())
        return f"""
<canvas id="trendChart" style="max-height:380px"></canvas>
<script>
(function(){{
  var ctx = document.getElementById('trendChart').getContext('2d');
  new Chart(ctx, {{
    type: 'line',
    data: {{
      labels: {labels},
      datasets: [
        {{ label: 'Picked', data: {picked}, borderColor:'#22c55e', backgroundColor:'rgba(34,197,94,0.1)',
           tension:0.3, fill:true, pointRadius:4 }},
        {{ label: 'Packed', data: {packed}, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.1)',
           tension:0.3, fill:true, pointRadius:4 }}
      ]
    }},
    options: {{
      responsive:true, interaction:{{ mode:'index', intersect:false }},
      plugins:{{ legend:{{ labels:{{ color:'#e2e8f0' }} }} }},
      scales:{{
        x:{{ ticks:{{ color:'#94a3b8', maxRotation:45 }}, grid:{{ color:'rgba(0,0,0,0.06)' }} }},
        y:{{ ticks:{{ color:'#94a3b8' }}, grid:{{ color:'rgba(0,0,0,0.06)' }}, beginAtZero:true }}
      }}
    }}
  }});
}})();
</script>"""

    # ── Picking cols ──────────────────────────────────────────────────────────
    PICK_COLS  = ["clientname", "ClientPriority", "shipmentordercode", "waveno",
                  "allocationdate", "AgeLabel", "pickingstatus", "UrgencyLevel", "SLAType"]
    D2C_PICK_COLS = ["clientname", "ClientPriority", "shipmentordercode", "waveno",
                     "pickingtype", "allocationdate", "AgeLabel", "pickingstatus", "UrgencyLevel", "SLAType"]
    PACK_COLS  = ["clientname", "ClientPriority", "shipmentordercode", "waveno",
                  "allocationdate", "AgeLabel", "packingstatus", "UrgencyLevel", "SLAType"]
    NOPACK_COLS = ["clientname", "ClientPriority", "shipmentordercode", "waveno",
                   "pickingcompletedat", "AgeLabel", "alert", "UrgencyLevel"]

    ts       = now.strftime("%Y-%m-%d %H:%M:%S %Z")
    next_min = (now.replace(second=0, microsecond=0) + timedelta(minutes=15)).strftime("%H:%M")

    tabs = [
        ("today",    "Today's Progress",   today_section(today_df)),
        ("d2c_pick", "D2C Picking",         cards(d2c_pick, "Tasks") + queue_table(d2c_pick,  D2C_PICK_COLS)),
        ("d2c_pack", "D2C Packing",         cards(d2c_pack, "Tasks") + queue_table(d2c_pack,  PACK_COLS)),
        ("spd_pick", "SPD Picking",         cards(spd_pick)           + queue_table(spd_pick,  PICK_COLS)),
        ("spd_pack", "SPD Packing",         cards(spd_pack)           + queue_table(spd_pack,  PACK_COLS)),
        ("ltl_pick", "LTL Picking",         cards(ltl_pick)           + queue_table(ltl_pick,  PICK_COLS)),
        ("ltl_pack", "LTL Packing",         cards(ltl_pack)           + queue_table(ltl_pack,  PACK_COLS)),
        ("ltl_np",   "LTL No-Pack Alert",   cards(ltl_nopack)         + queue_table(ltl_nopack, NOPACK_COLS)),
        ("trend",    "Daily Trend",         trend_chart(hist_df)),
    ]

    tab_nav = "".join(
        f'<li class="nav-item"><a class="nav-link{" active" if i==0 else ""}" '
        f'data-bs-toggle="tab" href="#{t[0]}">{esc(t[1])}'
        + (f' <span class="badge bg-secondary ms-1">{len(d2c_pick) if t[0]=="d2c_pick" else len(d2c_pack) if t[0]=="d2c_pack" else len(spd_pick) if t[0]=="spd_pick" else len(spd_pack) if t[0]=="spd_pack" else len(ltl_pick) if t[0]=="ltl_pick" else len(ltl_pack) if t[0]=="ltl_pack" else len(ltl_nopack) if t[0]=="ltl_np" else ""}</span>' if t[0] not in ("today","trend") else "")
        + '</a></li>'
        for i, t in enumerate(tabs)
    )
    tab_content = "".join(
        f'<div class="tab-pane fade{"  show active" if i==0 else ""}" id="{t[0]}">'
        f'<div class="tab-inner">{t[2]}</div></div>'
        for i, t in enumerate(tabs)
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WMS Dashboard</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
<style>
  body {{ background:#0f172a; color:#e2e8f0; font-family:'Segoe UI',sans-serif; font-size:0.88rem; }}
  .topbar {{ background:#1e293b; border-bottom:1px solid #334155; padding:0.6rem 1.2rem;
             display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:100; }}
  .topbar h1 {{ font-size:1.1rem; font-weight:700; color:#f1f5f9; margin:0; }}
  .topbar .meta {{ color:#94a3b8; font-size:0.8rem; }}
  #countdown {{ color:#22c55e; font-weight:600; }}
  .nav-tabs {{ border-bottom:1px solid #334155; background:#1e293b; padding:0 1rem; }}
  .nav-tabs .nav-link {{ color:#94a3b8; border:none; border-bottom:2px solid transparent;
                          padding:.5rem .9rem; font-size:.83rem; }}
  .nav-tabs .nav-link.active {{ color:#f1f5f9; border-bottom-color:#3b82f6; background:transparent; }}
  .nav-tabs .nav-link:hover {{ color:#e2e8f0; }}
  .tab-inner {{ padding:1.2rem 1rem; }}
  .cards-row {{ display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1.2rem; }}
  .card-box {{ background:#1e293b; border:1px solid #334155; border-radius:10px;
               padding:1rem 1.4rem; min-width:140px; flex:1; border-top:3px solid #334155; }}
  .card-box.danger  {{ border-top-color:#dc2626; }}
  .card-box.warning {{ border-top-color:#d97706; }}
  .card-box.success {{ border-top-color:#16a34a; }}
  .card-val {{ font-size:2rem; font-weight:700; color:#f1f5f9; line-height:1; }}
  .card-lbl {{ font-size:.75rem; color:#94a3b8; margin-top:.3rem; text-transform:uppercase; letter-spacing:.05em; }}
  .tbl-wrap {{ overflow-x:auto; border-radius:8px; border:1px solid #334155; }}
  .qtable  {{ width:100%; border-collapse:collapse; background:#1e293b; margin:0; }}
  .qtable thead th {{ background:#0f172a; color:#94a3b8; font-size:.75rem; text-transform:uppercase;
                      letter-spacing:.06em; padding:.55rem .7rem; border-bottom:1px solid #334155;
                      white-space:nowrap; position:sticky; top:0; }}
  .qtable tbody td {{ padding:.45rem .7rem; border-bottom:1px solid rgba(0,0,0,0.06);
                       vertical-align:middle; white-space:nowrap; }}
  .qtable tbody tr:last-child td {{ border-bottom:none; }}
  .qtable tbody tr:hover {{ background:rgba(0,0,0,0.06) !important; }}
  .badge {{ font-size:.73rem; font-weight:600; padding:.25em .6em; border-radius:4px; }}
  .empty-msg {{ color:#64748b; font-style:italic; margin-top:1rem; }}
</style>
</head>
<body>
<div class="topbar">
  <h1>⚡ WMS Operations Dashboard</h1>
  <div class="meta">
    Last updated: <strong>{ts}</strong> &nbsp;|&nbsp; Next refresh: <strong id="countdown">{next_min}</strong>
  </div>
</div>
<ul class="nav nav-tabs" id="mainTabs">{tab_nav}</ul>
<div class="tab-content">{tab_content}</div>
<script>
// Auto-reload after REFRESH_SECS seconds
var secs = {REFRESH_SECS};
function tick() {{
  secs--;
  if (secs <= 0) {{ location.reload(); return; }}
  var m = Math.floor(secs/60), s = secs%60;
  var el = document.getElementById('countdown');
  if (el) el.textContent = m + ':' + (s<10?'0':'') + s;
}}
setInterval(tick, 1000);
// Persist active tab across reloads
var key = 'wms_active_tab';
var saved = localStorage.getItem(key);
if (saved) {{ var el = document.querySelector('[href="#'+saved+'"]'); if(el) new bootstrap.Tab(el).show(); }}
document.querySelectorAll('[data-bs-toggle="tab"]').forEach(function(el){{
  el.addEventListener('shown.bs.tab', function(e){{ localStorage.setItem(key, e.target.getAttribute('href').replace('#','')); }});
}});
</script>
</body>
</html>"""

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(html)


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    tz        = pytz.timezone(TIMEZONE)
    now       = datetime.now(tz)
    is_monday = now.weekday() == 0

    # ── Load priority lists from local CSVs ───────────────────────────────────
    d2c_pri = load_priority("d2c_priority.csv")
    spd_pri = load_priority("spd_priority.csv")
    ltl_pri = load_priority("ltl_priority.csv")
    logger.info(
        f"Priority lists loaded — D2C: {len(d2c_pri)} | SPD: {len(spd_pri)} | LTL: {len(ltl_pri)}"
    )

    # ── D2C Packing ───────────────────────────────────────────────────────────
    logger.info("D2C packing queue...")
    d2c_pack = query_snowflake(D2C_PACKING_SQL)
    logger.info(f"  → Raw query rows: {len(d2c_pack)} | Columns: {list(d2c_pack.columns)}")
    d2c_pack = build_queue(
        d2c_pack,
        lambda r, n, t: _d2c_urgency(r, n, t, ref_col="pickingcompletedat"),
        d2c_pri, now, tz, is_packing=True
    )
    logger.info(f"  → After build_queue: {len(d2c_pack)} rows")

    # ── D2C Picking ───────────────────────────────────────────────────────────
    logger.info("D2C picking queue...")
    d2c_pick = query_snowflake(D2C_PICKING_SQL)
    d2c_pick = build_queue(
        d2c_pick,
        lambda r, n, t: _d2c_urgency(r, n, t, ref_col="allocationdate", is_picking=True),
        d2c_pri, now, tz,
        is_monday=is_monday, suppress_p4=True
    )

    # ── D2B SPD Packing ───────────────────────────────────────────────────────
    logger.info("D2B SPD packing queue...")
    spd_pack = query_snowflake(D2B_SPD_PACKING_SQL)
    spd_pack = build_queue(
        spd_pack,
        lambda r, n, t: _d2b_urgency(r, n, t, D2B_SPD_SLA_HRS),
        spd_pri, now, tz, is_packing=True
    )

    # ── D2B SPD Picking ───────────────────────────────────────────────────────
    logger.info("D2B SPD picking queue...")
    spd_pick = query_snowflake(D2B_SPD_PICKING_SQL)
    spd_pick = build_queue(
        spd_pick,
        lambda r, n, t: _d2b_urgency(r, n, t, D2B_SPD_SLA_HRS, is_picking=True),
        spd_pri, now, tz
    )

    # ── D2B LTL Packing ───────────────────────────────────────────────────────
    logger.info("D2B LTL packing queue...")
    ltl_pack = query_snowflake(D2B_LTL_PACKING_SQL)
    ltl_pack = build_queue(
        ltl_pack,
        lambda r, n, t: _d2b_urgency(r, n, t, D2B_LTL_SLA_HRS),
        ltl_pri, now, tz, is_packing=True
    )

    # ── D2B LTL Picking ───────────────────────────────────────────────────────
    logger.info("D2B LTL picking queue...")
    ltl_pick = query_snowflake(D2B_LTL_PICKING_SQL)
    ltl_pick = build_queue(
        ltl_pick,
        lambda r, n, t: _d2b_urgency(r, n, t, D2B_LTL_SLA_HRS, is_picking=True),
        ltl_pri, now, tz
    )

    # ── D2B LTL No-Pack Alert ─────────────────────────────────────────────────
    logger.info("D2B LTL no-pack alert...")
    ltl_nopack = query_snowflake(D2B_LTL_NOPACK_SQL)
    ltl_nopack = build_queue(
        ltl_nopack,
        lambda r, n, t: _d2b_urgency(r, n, t, D2B_LTL_SLA_HRS),
        ltl_pri, now, tz, is_packing=True
    )

    # ── Today's Progress ──────────────────────────────────────────────────────
    logger.info("Today's progress...")
    logger.info(f"  → today_str used in SQL: {_today_str}")
    today_df = query_snowflake(TODAY_PROGRESS_SQL)
    if not today_df.empty:
        logger.info(f"  → Activity breakdown:\n{today_df['activitytype'].value_counts().to_string()}")
        logger.info(f"  → Completion breakdown:\n{today_df['completionstatus'].value_counts().to_string()}")

    # ── Daily History (60-day trend + intraday snapshots for today) ──────────
    logger.info("Daily history trend...")
    hist_df = query_snowflake(DAILY_HISTORY_SQL)

    def _add_totals(df):
        num_cols = ["d2c_picked", "d2c_packed", "spd_picked", "spd_packed", "ltl_picked", "ltl_packed"]
        for col in num_cols:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)
        df["TotalPicked"] = df["d2c_picked"] + df["spd_picked"] + df["ltl_picked"]
        df["TotalPacked"] = df["d2c_packed"] + df["spd_packed"] + df["ltl_packed"]
        if "dailyallocated" in df.columns:
            df["dailyallocated"] = pd.to_numeric(df["dailyallocated"], errors="coerce").fillna(0).astype(int)
        return df

    if not hist_df.empty:
        hist_df = _add_totals(hist_df)

    today_date_str = _today_str
    # Past days: one row per day from Snowflake (deduplicated)
    hist_past = (hist_df[hist_df["workdate"].astype(str) < today_date_str]
                 .drop_duplicates(subset=["workdate"], keep="last")
                 .copy())
    hist_today = hist_df[hist_df["workdate"].astype(str) == today_date_str].copy()

    # Build today's snapshot row with current timestamp
    if not hist_today.empty:
        snap = hist_today.copy()
        snap["workdate"] = now.strftime("%Y-%m-%d %H:%M")
    else:
        snap = pd.DataFrame()

    # Read accumulated today snapshots from local CSV
    try:
        prev = pd.read_csv(HISTORY_CSV)
        prev.columns = [c.lower() if c not in ["TotalPicked","TotalPacked"] else c for c in prev.columns]
        prev_today = prev[prev["workdate"].astype(str).str.startswith(today_date_str + " ")].copy()
        if not prev_today.empty:
            prev_today = _add_totals(prev_today)
            prev_today = prev_today.drop_duplicates(subset=["workdate"], keep="last")
    except Exception:
        prev_today = pd.DataFrame()

    # Combine: historical daily rows + previous today snapshots + new snapshot
    frames     = [f for f in [hist_past, prev_today, snap] if not f.empty]
    final_hist = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


    # ── Open & Shortage Orders ────────────────────────────────────────────────
    logger.info("Open & Shortage orders...")
    open_shortage_df = query_snowflake(_open_shortage_sql())

    # ── Hourly breakdown for today ────────────────────────────────────────────
    logger.info("Hourly breakdown today...")
    hourly_df = query_snowflake(_hourly_today_sql())

    logger.info("Hourly baseline (45-day peak)...")
    baseline_df = query_snowflake(_hourly_baseline_sql())

    # ── ON HOLD orders (Logiwa API) ───────────────────────────────────────────
    _all_queue_frames = [f for f in [d2c_pick, d2c_pack, spd_pick, spd_pack,
                                     ltl_pick, ltl_pack, ltl_nopack] if not f.empty]
    _all_queue = pd.concat(_all_queue_frames, ignore_index=True) if _all_queue_frames else pd.DataFrame()
    logger.info("Fetching ON HOLD order codes from Logiwa (page scan, max 25s)...")
    on_hold_codes = fetch_on_hold_codes()
    if not _all_queue.empty and on_hold_codes:
        on_hold_df = _all_queue[
            _all_queue["shipmentordercode"].str.upper().isin({c.upper() for c in on_hold_codes})
        ].copy()
    else:
        on_hold_df = pd.DataFrame()
    logger.info(f"  → ON HOLD orders in queue: {len(on_hold_df)}")

    # ── HTML Dashboard ────────────────────────────────────────────────────────
    logger.info("Writing HTML dashboard...")
    html_path = r"C:\Users\user\Desktop\Claude\wms_dashboard\wms_dashboard.html"
    _generate_html(
        d2c_pack, d2c_pick,
        spd_pack, spd_pick,
        ltl_pack, ltl_pick,
        ltl_nopack, today_df, final_hist,
        open_shortage_df, hourly_df, baseline_df,
        on_hold_df, now, html_path
    )
    logger.info(f"  → HTML dashboard written → {html_path}")

    # ── GitHub Pages deploy ───────────────────────────────────────────────────
    GH_TOKEN    = os.environ.get("GH_PAT", "")
    GH_USER     = "eshipperplus"
    GH_REPO     = "eshipperplus"
    GH_URL      = f"https://{GH_USER}.github.io/{GH_REPO}/"
    try:
        import base64, requests as _req
        _content = open(html_path, "rb").read()
        _b64     = base64.b64encode(_content).decode()
        _api     = f"https://api.github.com/repos/{GH_USER}/{GH_REPO}/contents/index.html"
        _headers = {"Authorization": f"token {GH_TOKEN}", "Accept": "application/vnd.github.v3+json"}
        # Get current SHA so we can update (not create) the file
        _get = _req.get(_api, headers=_headers, timeout=30)
        _sha = _get.json().get("sha") if _get.status_code == 200 else None
        _payload = {"message": f"Deploy {now.strftime('%Y-%m-%d %H:%M')}", "content": _b64}
        if _sha:
            _payload["sha"] = _sha
        _put = _req.put(_api, headers=_headers, json=_payload, timeout=60)
        if _put.status_code in (200, 201):
            logger.info(f"  → GitHub Pages deploy: success → {GH_URL}")
        else:
            logger.warning(f"  → GitHub Pages deploy failed: {_put.status_code} {_put.text[:200]}")
    except Exception as e:
        logger.warning(f"  → GitHub Pages deploy error: {e}")

    logger.info(
        f"Done. "
        f"D2C Pack={len(d2c_pack)} Pick={len(d2c_pick)} | "
        f"SPD Pack={len(spd_pack)} Pick={len(spd_pick)} | "
        f"LTL Pack={len(ltl_pack)} Pick={len(ltl_pick)} NoPack={len(ltl_nopack)} | "
        f"Today={len(today_df)} | History={len(hist_df)}"
    )

if __name__ == "__main__":
    main()
