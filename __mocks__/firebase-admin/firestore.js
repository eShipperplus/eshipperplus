'use strict';
const { db, Timestamp, FieldValue } = require('../../tests/helpers/store');
module.exports = {
  getFirestore: () => db,
  Timestamp,
  FieldValue,
};
