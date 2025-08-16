if (process.env.JS_SANITIZER_DEBUG) {
  console.log("########### INDEX JS-SANITIZER #################");
}
module.exports = require("./sanitizer.js");
