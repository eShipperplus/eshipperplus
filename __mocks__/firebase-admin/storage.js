'use strict';
const { bucket } = require('../../tests/helpers/store');
module.exports = { getStorage: () => ({ bucket: () => bucket }) };
