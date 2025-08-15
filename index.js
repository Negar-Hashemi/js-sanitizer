// index.js
const sanitizer = require('./sanitizer.js');

module.exports = function (babel, options) {
  return sanitizer(babel, options);
};
