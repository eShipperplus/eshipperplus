'use strict';
const path = require('path');
const data = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'jest-results.json'), 'utf8'));
const rows = [];

(data.testResults || []).forEach(suite => {
  const filePath = (suite.name || '').replace(/\\/g, '/');
  const file = filePath.split('/').pop();
  (suite.assertionResults || []).forEach(t => {
    const name = [...(t.ancestorTitles || []), t.title].join(' > ');
    rows.push({ suite: file, name, status: t.status });
  });
});

const pad = (s, n) => String(s || '').padEnd(n).slice(0, n);
console.log('\n' + pad('SUITE', 28) + ' | ' + pad('TEST CASE', 70) + ' | RESULT');
console.log('-'.repeat(28) + '-+-' + '-'.repeat(70) + '-+---------');

let lastSuite = '';
rows.forEach(r => {
  const icon = r.status === 'passed' ? '✓ PASS' : '✕ FAIL';
  const sLabel = r.suite !== lastSuite ? r.suite : '';
  lastSuite = r.suite;
  console.log(pad(sLabel, 28) + ' | ' + pad(r.name, 70) + ' | ' + icon);
});

console.log('\n' + '─'.repeat(114));
console.log((data.success ? '✓' : '✕') + ' Total: ' + data.numTotalTests + '  |  Passed: ' + data.numPassedTests + '  |  Failed: ' + data.numFailedTests + '  |  Suites: ' + data.numTotalTestSuites);
