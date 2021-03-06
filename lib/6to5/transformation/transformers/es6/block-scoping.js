"use strict";

var traverse = require("../../../traverse");
var object   = require("../../../helpers/object");
var util     = require("../../../util");
var t        = require("../../../types");
var _        = require("lodash");

var isLet = function (node, parent) {
  if (!t.isVariableDeclaration(node)) return false;
  if (node._let) return true;
  if (node.kind !== "let") return false;

  // https://github.com/6to5/6to5/issues/255
  if (!t.isFor(parent) || t.isFor(parent) && parent.left !== node) {
    for (var i = 0; i < node.declarations.length; i++) {
      var declar = node.declarations[i];
      declar.init = declar.init || t.identifier("undefined");
    }
  }

  node._let = true;
  node.kind = "var";
  return true;
};

var isVar = function (node, parent) {
  return t.isVariableDeclaration(node, { kind: "var" }) && !isLet(node, parent);
};

var standardiseLets = function (declars) {
  for (var i = 0; i < declars.length; i++) {
    delete declars[i]._let;
  }
};

exports.VariableDeclaration = function (node, parent) {
  isLet(node, parent);
};

exports.Loop = function (node, parent, scope, context, file) {
  var init = node.left || node.init;
  if (isLet(init, node)) {
    t.ensureBlock(node);
    node.body._letDeclarators = [init];
  }

  if (t.isLabeledStatement(parent)) {
    // set label so `run` has access to it
    node.label = parent.label;
  }

  var letScoping = new LetScoping(node, node.body, parent, scope, file);
  letScoping.run();

  if (node.label && !t.isLabeledStatement(parent)) {
    // we've been given a label so let's wrap ourselves
    return t.labeledStatement(node.label, node);
  }
};

exports.Program =
exports.BlockStatement = function (block, parent, scope, context, file) {
  if (!t.isLoop(parent)) {
    var letScoping = new LetScoping(false, block, parent, scope, file);
    letScoping.run();
  }
};

/**
 * Description
 *
 * @param {Boolean|Node} loopParent
 * @param {Node} block
 * @param {Node} parent
 * @param {Scope} scope
 * @param {File} file
 */

function LetScoping(loopParent, block, parent, scope, file) {
  this.loopParent = loopParent;
  this.parent     = parent;
  this.scope      = scope;
  this.block      = block;
  this.file       = file;

  this.outsideLetReferences = object();
  this.hasLetReferences     = false;
  this.letReferences        = block._letReferences = object();
  this.body                 = [];
}

/**
 * Start the ball rolling.
 */

LetScoping.prototype.run = function () {
  var block = this.block;
  if (block._letDone) return;
  block._letDone = true;

  var needsClosure = this.getLetReferences();

  // this is a block within a `Function/Program` so we can safely leave it be
  if (t.isFunction(this.parent) || t.isProgram(this.block)) return;

  // we can skip everything
  if (!this.hasLetReferences) return;

  if (needsClosure) {
    this.needsClosure();
  } else {
    this.remap();
  }
};

function replace(node, parent, scope, context, remaps) {
  if (!t.isReferencedIdentifier(node, parent)) return;

  var remap = remaps[node.name];
  if (!remap) return;

  var own = scope.get(node.name, true);
  if (own === remap.node) {
    node.name = remap.uid;
  } else {
    // scope already has it's own declaration that doesn't
    // match the one we have a stored replacement for
    if (context) context.skip();
  }
}

var replaceVisitor = {
  enter: replace
};

function traverseReplace(node, parent, scope, remaps) {
  replace(node, parent, scope, null, remaps);
  traverse(node, replaceVisitor, scope, remaps);
}

/**
 * Description
 */

LetScoping.prototype.remap = function () {
  var hasRemaps = false;
  var letRefs   = this.letReferences;
  var scope     = this.scope;

  // alright, so since we aren't wrapping this block in a closure
  // we have to check if any of our let variables collide with
  // those in upper scopes and then if they do, generate a uid
  // for them and replace all references with it
  var remaps = object();

  for (var key in letRefs) {
    // just an Identifier node we collected in `getLetReferences`
    // this is the defining identifier of a declaration
    var ref = letRefs[key];

    if (scope.parentHas(key)) {
      var uid = scope.generateUidIdentifier(ref.name).name;
      ref.name = uid;

      hasRemaps = true;
      remaps[key] = remaps[uid] = {
        node: ref,
        uid: uid
      };
    }
  }

  if (!hasRemaps) return;

  //

  var loopParent = this.loopParent;
  if (loopParent) {
    traverseReplace(loopParent.right, loopParent, scope, remaps);
    traverseReplace(loopParent.test, loopParent, scope, remaps);
    traverseReplace(loopParent.update, loopParent, scope, remaps);
  }

  traverse(this.block, replaceVisitor, scope, remaps);
};

/**
 * Description
 */

LetScoping.prototype.needsClosure = function () {
  var block = this.block;

  // if we're inside of a for loop then we search to see if there are any
  // `break`s, `continue`s, `return`s etc
  this.has = this.checkLoop();

  // hoist var references to retain scope
  this.hoistVarDeclarations();

  // turn outsideLetReferences into an array
  var params = _.values(this.outsideLetReferences);

  // build the closure that we're going to wrap the block with
  var fn = t.functionExpression(null, params, t.blockStatement(block.body));
  fn._aliasFunction = true;

  // replace the current block body with the one we're going to build
  block.body = this.body;

  // build a call and a unique id that we can assign the return value to
  var call = t.callExpression(fn, params);
  var ret  = this.scope.generateUidIdentifier("ret");

  // handle generators
  var hasYield = traverse.hasType(fn.body, this.scope, "YieldExpression", t.FUNCTION_TYPES);
  if (hasYield) {
    fn.generator = true;
    call = t.yieldExpression(call, true);
  }

  // handlers async functions
  var hasAsync = traverse.hasType(fn.body, this.scope, "AwaitExpression", t.FUNCTION_TYPES);
  if (hasAsync) {
    fn.async = true;
    call = t.awaitExpression(call, true);
  }

  this.build(ret, call);
};

var letReferenceFunctionVisitor = {
  enter: function (node, parent, scope, context, state) {
    // not a direct reference
    if (!t.isReferencedIdentifier(node, parent)) return;

    // this scope has a variable with the same name so it couldn't belong
    // to our let scope
    if (scope.hasOwn(node.name, true)) return;

    // not a part of our scope
    if (!state.letReferences[node.name]) return;

    state.closurify = true;
  }
};

var letReferenceBlockVisitor = {
  enter: function (node, parent, scope, context, state) {
    if (t.isFunction(node)) {
      traverse(node, letReferenceFunctionVisitor, scope, state);
      return context.skip();
    }
  }
};

/**
 * Description
 */

LetScoping.prototype.getLetReferences = function () {
  var block = this.block;

  var declarators = block._letDeclarators || [];
  var declar;

  //
  for (var i = 0; i < declarators.length; i++) {
    declar = declarators[i];
    _.extend(this.outsideLetReferences, t.getIds(declar, true));
  }

  //
  if (block.body) {
    for (i = 0; i < block.body.length; i++) {
      declar = block.body[i];
      if (isLet(declar, block)) {
        declarators = declarators.concat(declar.declarations);
      }
    }
  }

  //
  for (i = 0; i < declarators.length; i++) {
    declar = declarators[i];
    var keys = t.getIds(declar, true);
    _.extend(this.letReferences, keys);
    this.hasLetReferences = true;
  }

  // no let references so we can just quit
  if (!this.hasLetReferences) return;

  // set let references to plain var references
  standardiseLets(declarators);

  var state = {
    letReferences: this.letReferences,
    closurify:     false
  };

  // traverse through this block, stopping on functions and checking if they
  // contain any local let references
  traverse(this.block, letReferenceBlockVisitor, this.scope, state);

  return state.closurify;
};

var loopVisitor = {
  enter: function (node, parent, scope, context, state) {
    var replace;

    if (t.isFunction(node) || t.isLoop(node)) {
      return context.skip();
    }

    if (node && !node.label && state.isLoop) {
      if (t.isBreakStatement(node)) {
        if (t.isSwitchCase(parent)) return;

        state.hasBreak = true;
        replace = t.returnStatement(t.literal("break"));
      } else if (t.isContinueStatement(node)) {
        state.hasContinue = true;
        replace = t.returnStatement(t.literal("continue"));
      }
    }

    if (t.isReturnStatement(node)) {
      state.hasReturn = true;
      replace = t.returnStatement(t.objectExpression([
        t.property("init", t.identifier("v"), node.argument || t.identifier("undefined"))
      ]));
    }

    if (replace) return t.inherits(replace, node);
  }
};

/**
 * If we're inside of a loop then traverse it and check if it has one of
 * the following node types `ReturnStatement`, `BreakStatement`,
 * `ContinueStatement` and replace it with a return value that we can track
 * later on.
 *
 * @returns {Object}
 */

LetScoping.prototype.checkLoop = function () {
  var state = {
    hasContinue: false,
    hasReturn:   false,
    hasBreak:    false,
    isLoop:      !!this.loopParent
  };

  traverse(this.block, loopVisitor, this.scope, state);
  return state;
};

var hoistVarDeclarationsVisitor = {
  enter: function (node, parent, scope, context, self) {
    if (t.isForStatement(node)) {
      if (isVar(node.init, node)) {
        node.init = t.sequenceExpression(self.pushDeclar(node.init));
      }
    } else if (t.isFor(node)) {
      if (isVar(node.left, node)) {
        node.left = node.left.declarations[0].id;
      }
    } else if (isVar(node, parent)) {
      return self.pushDeclar(node).map(t.expressionStatement);
    } else if (t.isFunction(node)) {
      return context.skip();
    }
  }
};

/**
 * Hoist all var declarations in this block to before it so they retain scope
 * once we wrap everything in a closure.
 */

LetScoping.prototype.hoistVarDeclarations = function () {
  traverse(this.block, hoistVarDeclarationsVisitor, this.scope, this);
};

/**
 * Turn a `VariableDeclaration` into an array of `AssignmentExpressions` with
 * their declarations hoisted to before the closure wrapper.
 *
 * @param {Node} node VariableDeclaration
 * @returns {Array}
 */

LetScoping.prototype.pushDeclar = function (node) {
  this.body.push(t.variableDeclaration(node.kind, node.declarations.map(function (declar) {
    return t.variableDeclarator(declar.id);
  })));

  var replace = [];

  for (var i = 0; i < node.declarations.length; i++) {
    var declar = node.declarations[i];
    if (!declar.init) continue;

    var expr = t.assignmentExpression("=", declar.id, declar.init);
    replace.push(t.inherits(expr, declar));
  }

  return replace;
};

/**
 * Push the closure to the body.
 *
 * @param {Node} ret Identifier
 * @param {Node} call CallExpression
 */

LetScoping.prototype.build = function (ret, call) {
  var has = this.has;
  if (has.hasReturn || has.hasBreak || has.hasContinue) {
    this.buildHas(ret, call);
  } else {
    this.body.push(t.expressionStatement(call));
  }
};

/**
 * Description
 *
 * @param {Node} ret Identifier
 * @param {Node} call CallExpression
 */

LetScoping.prototype.buildHas = function (ret, call) {
  var body = this.body;

  body.push(t.variableDeclaration("var", [
    t.variableDeclarator(ret, call)
  ]));

  var loopParent = this.loopParent;
  var retCheck;
  var has = this.has;
  var cases = [];

  if (has.hasReturn) {
    // typeof ret === "object"
    retCheck = util.template("let-scoping-return", {
      RETURN: ret
    });
  }

  if (has.hasBreak || has.hasContinue) {
    if (!loopParent) {
      throw new Error("Has no loop parent but we're trying to reassign breaks " +
                      "and continues, something is going wrong here.");
    }

    // ensure that the parent has a label as we're building a switch and we
    // need to be able to access it
    var label = loopParent.label = loopParent.label || this.scope.generateUidIdentifier("loop");

    if (has.hasBreak) {
      cases.push(t.switchCase(t.literal("break"), [t.breakStatement(label)]));
    }

    if (has.hasContinue) {
      cases.push(t.switchCase(t.literal("continue"), [t.continueStatement(label)]));
    }

    if (has.hasReturn) {
      cases.push(t.switchCase(null, [retCheck]));
    }

    if (cases.length === 1) {
      var single = cases[0];
      body.push(t.ifStatement(
        t.binaryExpression("===", ret, single.test),
        single.consequent[0]
      ));
    } else {
      body.push(t.switchStatement(ret, cases));
    }
  } else {
    if (has.hasReturn) body.push(retCheck);
  }
};
