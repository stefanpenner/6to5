define(["exports", "foo", "foo-bar", "./directory/foo-bar"], function (exports, _foo, _fooBar, _directoryFooBar) {
  "use strict";

  var _interopRequire = function (obj) { return obj && obj.__esModule ? obj["default"] : obj; };

  var foo = _interopRequire(_foo);

  var foo2 = _foo;
  var bar = _foo.bar;
  var bar2 = _foo.foo;
  exports.test = test;
  var test2 = exports.test2 = 5;

  exports["default"] = test;
  exports.__esModule = true;
});