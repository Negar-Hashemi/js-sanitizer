// index.js
const sanitizer = require('./sanitizer.js');
console.log(`########### INDEX JS-SANITIZER #################`);
module.exports = function (babel, options) {
  return sanitizer(babel, options);
};
