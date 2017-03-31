/* jshint node: true */
'use strict';
var stream = require('stream');
var fs = require('fs');
var Promise = require('bluebird');
var deepAssign = require('deep-assign')

var exports = module.exports = {};

var CHAR_NEWLINE = 10;
var CHAR_SPACE = 32;
var CHAR_LEFT_PARENTHESIS = 40;
var CHAR_RIGHT_PARENTHESIS = 41;
var CHAR_SLASH = 47;
var CHAR_EQUALS = 61;
var CHAR_ARRAY_START = 91;
var CHAR_BACKSLASH = 92;
var CHAR_ARRAY_END = 93;
var CHAR_BLOCK_START = 123;
var CHAR_BLOCK_END = 125;

// Use top-level to define global variables
// Reference: https://developer.android.com/studio/build/gradle-tips.html
// In module-level gradle scripts, especially in dependencies, evaluate the variables
// $ starts evaluation, optionally, there will be block start and end for the variable, i.e. {}, or simply :, end,
var CHAR_EVAL_START = 36;
// 1. "$rootDir/test-reports", 2. ${minutesSinceEpoch}, 3. com.android.support:design:$supportLibraryVersion
var CHAR_COLON = 58;
var CHAR_SEMICOLON = 59;
var CHAR_DOUBLE_QUOTE = 34;
var CHAR_SINGLE_QUOTE = 39;
var CHAR_EVAL_END = [CHAR_SPACE, CHAR_SLASH, CHAR_COLON, CHAR_SEMICOLON, CHAR_DOUBLE_QUOTE, CHAR_SINGLE_QUOTE];

var KEYWORD_DEF = 'def';
var KEYWORD_STRING = 'String';
var KEYWORD_IF = 'if';

var WHITESPACE_CHARACTERS = {};
WHITESPACE_CHARACTERS[CHAR_NEWLINE] = true;
WHITESPACE_CHARACTERS[CHAR_SPACE] = true;

// track the global variables defined in ext
// ext can be ext {}, and can be project.ext {}
// Reference: https://medium.com/@ali.muzaffar/gradle-configure-variables-for-all-android-project-modules-in-one-place-5a6e56cd384e
var EXT_KEYS = ['buildscript', 'configure', 'ext', 'project.ext'];  // 'configure(allprojects)' fails!
var ext_variables = {};

var SPECIAL_KEYS = {
  repositories: parseRepositoryClosure
};

function dumpStructureContent(structure, recursive, depth) {
  recursive = recursive || false;
  depth = depth || 0;

  // only print stuff if at level 0
  if (depth == 0)
    // console.log("dumping content from structure");

  // iterable properties to print stuff
  for (var property in structure) {
    if (structure.hasOwnProperty(property)) {
        // console.log("key: %s, value: %s, depth: %s", property, structure[property], depth);
        if (structure[property] && typeof structure[property] === 'object' && recursive)
          dumpStructureContent(structure[property], recursive, depth+1);
    }
  }
}

function deepParse(chunk, state, keepFunctionCalls, skipEmptyValues) {
  var out = {};

  var chunkLength = chunk.length;
  var character = 0;
  var previousCharacter = 0;
  var tempString = '';
  var tempStringEval = '';
  var commentText = '';

  var currentKey = '';
  var parsingKey = true;
  var isBeginningOfLine = true;

  if (typeof skipEmptyValues === 'undefined') {
    skipEmptyValues = true;
  }

  for (; state.index < chunkLength; state.index++) {
    previousCharacter = character;
    character = chunk[state.index];

    if (isBeginningOfLine && isWhitespace(character)) {
      continue;
    }

    // track whether the statement is in opening quotes or not
    if (state.quote.open) {
      if (state.quote.equalsQuoteChar(character) && previousCharacter != CHAR_BACKSLASH)
        state.quote.flipStatus();
    } else {
      if (state.evaluation.isQuote(character) && previousCharacter != CHAR_BACKSLASH) {
        state.quote.setQuoteChar(character);
        state.quote.flipStatus();
      }
    }

    if (!state.comment.parsing && isBeginningOfLine && isStartOfComment(tempString)) {
      isBeginningOfLine = false;
      if (isSingleLineComment(tempString)) {
        state.comment.setSingleLine();
      } else {
        state.comment.setMultiLine();
      }
    }

    if (!state.comment.parsing && !state.quote.open &&
        isStartOfComment(tempString.slice(tempString.length-3,tempString.length-1))) {
      // save the values processed so far!
      var tempValue = tempString.slice(0, tempString.length-3).trim();
      if (tempValue || (currentKey && !skipEmptyValues)) {
        // console.log("add new value in comment parsing: %s %s", currentKey, trimWrappingQuotes(tempValue));
        addValueToStructure(out, currentKey, trimWrappingQuotes(tempValue));
        if (state.evaluation.parsingDependencies) {
          // console.log("add new value to ext variables: %s %s", currentKey, trimWrappingQuotes(tempValue));
          addValueToStructure(ext_variables, currentKey, trimWrappingQuotes(tempValue));
        }
      }

      // comments at the end of each line
      currentKey = '';
      tempString = tempString.slice(tempString.length-3, tempString.length-1);
      if (isSingleLineComment(tempString)) {
        state.comment.setSingleLine();
      } else {
        state.comment.setMultiLine();
      }
    }

    if (state.comment.multiLine && isEndOfMultiLineComment(commentText)) {
      state.comment.reset();

      isBeginningOfLine = true;
      tempString = '';
      commentText = '';
      continue;
    }

    if (state.comment.parsing && character != CHAR_NEWLINE) {
      commentText += String.fromCharCode(character);
      continue;
    }

    if (state.comment.parsing && character === CHAR_NEWLINE) {
      // console.log("finished parsing the comment: %s", commentText);
      if (state.comment.singleLine) {
        state.comment.reset();
        parsingKey = true;
        isBeginningOfLine = true;

        currentKey = '';
        tempString = '';
        commentText = '';
        continue;
      } else {
        // NO-OP
        continue;
      }
    }

    if (parsingKey && !keepFunctionCalls && character === CHAR_LEFT_PARENTHESIS) {
      // console.log("skipping functions: %s %s", state.index, character);
      skipFunctionCall(chunk, state);
      currentKey = '';
      tempString = '';
      continue;
    }

    if (character === CHAR_NEWLINE) {
      if (!currentKey && tempString) {
        currentKey = tempString;
        tempString = '';
      }

      if (tempString || (currentKey && !skipEmptyValues)) {
        // console.log("add new value in char new line: %s %s", currentKey, trimWrappingQuotes(tempString));
        addValueToStructure(out, currentKey, trimWrappingQuotes(tempString));
        if (state.evaluation.parsingDependencies) {
          // console.log("add new value to ext variables: %s %s", currentKey, trimWrappingQuotes(tempString));
          addValueToStructure(ext_variables, currentKey, trimWrappingQuotes(tempString));
        }

        currentKey = '';
        tempString = '';
      }

      parsingKey = true;
      isBeginningOfLine = true;

      state.comment.reset();
      continue;
    }

    // Only parse as an array if the first *real* char is a [
    if (!parsingKey && !tempString && character === CHAR_ARRAY_START) {
      // console.log("parsing arrays: %s %s", state.index, character);
      out[currentKey] = parseArray(chunk, state);
      currentKey = '';
      tempString = '';
      continue;
    }

    // Parses an evaluation if the variable is in dependencies and starts with $
    if ((!state.evaluation.evalDependenciesOnly ||
         (state.evaluation.evalDependenciesOnly && state.evaluation.parsingDependencies)
        )   // test whether to evaluate
        && (character === CHAR_EVAL_START || state.evaluation.parsing)  // test whether this is evaluate
    ) {
        if (!state.evaluation.parsing) {
            // console.log("starting evaluation");
            state.evaluation.setParsingStart();
            tempStringEval = '';
            continue;
        } else {
            if (character === CHAR_BLOCK_START) {
                state.evaluation.setBraceStart();
                continue;
            } else if (character == CHAR_BLOCK_END) {
                state.evaluation.setBraceEnd();
                // Evaluate the variable!
                tempString += state.evaluation.evaluateVariable(tempStringEval);
                state.evaluation.setParsingEnd();
                continue;
            } else if (state.evaluation.isParsingEnd(character)) {
                // Evaluate the variable!
                tempString += state.evaluation.evaluateVariable(tempStringEval);
                // If the end character is quote, then append it to the tempString as well!
                if (state.evaluation.isQuote(character)) tempString += String.fromCharCode(character);
                state.evaluation.setParsingEnd();
                continue;
            } else {
                tempStringEval += String.fromCharCode(character);
                continue;
            }
        }
    }

    if (character === CHAR_BLOCK_START) {
      // console.log("parsing block start: %s %s for key %s", state.index, character, currentKey);
      // The space between key and { may be missing, so we should directly assign tempString to currentKey in this case!
      if (currentKey == '') currentKey = tempString;

      state.index++; // We need to skip the start character

      if (SPECIAL_KEYS.hasOwnProperty(currentKey)) {
        out[currentKey] = SPECIAL_KEYS[currentKey](chunk, state);
      } else if (out[currentKey]) {
        if (currentKey == 'dependencies') state.evaluation.setParsingDependenciesStart();
        out[currentKey] = deepAssign({}, out[currentKey], deepParse(chunk, state, keepFunctionCalls, skipEmptyValues));
        if (currentKey == 'dependencies') state.evaluation.setParsingDependenciesEnd();
      } else {
        if (currentKey == 'dependencies') state.evaluation.setParsingDependenciesStart();
        out[currentKey] = deepParse(chunk, state, keepFunctionCalls, skipEmptyValues);
        if (currentKey == 'dependencies') state.evaluation.setParsingDependenciesEnd();
      }


      //****************************************************************************
      // TODO: this is really ad-hoc! Fix this!
      //****************************************************************************
      // store the variables defined in ext block, for later use
      if (EXT_KEYS.indexOf(currentKey) > -1) {
        /** The possible format for configuring ext variables!
         *  ext {
                compileSdkVersion = 19
                buildToolsVersion = "20.0.0"
                minSDKVersion = 8
            }

            configure(allprojects) {
                ext.androidSDKVersion = "19"
                ext.androidBuildToolsVersion = "19.0"
                ...
            }
         */
        for (var property in out[currentKey])
          if (out[currentKey].hasOwnProperty(property)) {
            var propertyValue = out[currentKey][property];
            if (property.startsWith('ext.')) property = property.slice(4);
            addValueToStructure(ext_variables, property, propertyValue);
          }
      } else if (!currentKey) {
        for (var property in out[currentKey]) {
          if (out[currentKey].hasOwnProperty(property) && property.startsWith('ext.')) {
            var propertyValue = out[currentKey][property];
            addValueToStructure(ext_variables, property.slice(4), propertyValue);
          }
        }
      }
      currentKey = '';
    } else if (character === CHAR_BLOCK_END) {
      currentKey = '';
      tempString = '';
      break;
    } else if (isDelimiter(character) && parsingKey) {
      if (isKeyword(tempString)) {
        if (tempString === KEYWORD_DEF || tempString === KEYWORD_STRING) {
          tempString = fetchDefinedNameOrSkipFunctionDefinition(chunk, state);
        } else if (tempString === KEYWORD_IF) {
          skipIfBlock(chunk, state);
          currentKey = '';
          tempString = '';
          continue;
        }
      }

      currentKey = tempString;
      tempString = '';
      parsingKey = false;
      if (!currentKey) {
        continue;
      }
    } else {
      if (!tempString && isDelimiter(character)) {
        continue;
      }
      tempString += String.fromCharCode(character);
      isBeginningOfLine = isBeginningOfLine && (character === CHAR_SLASH || isStartOfComment(tempString));
    }
  }

  // Add the last value to the structure
  // console.log("add new value at the end of deep parse: %s %s", currentKey, trimWrappingQuotes(tempString));
  addValueToStructure(out, currentKey, trimWrappingQuotes(tempString));
  // Add String definitions, if they are defined inside dependencies!
  if (state.evaluation.parsingDependencies) {
      // console.log("add new value to ext variables: %s %s", currentKey, trimWrappingQuotes(tempString));
      addValueToStructure(ext_variables, currentKey, trimWrappingQuotes(tempString));
  }
  // console.log("dumping from deepParse, the end of parsing!");
  dumpStructureContent(out);
  return out;
}

function skipIfBlock(chunk, state) {
  skipFunctionCall(chunk, state);

  var character = '';
  var hasFoundTheCurlyBraces = false;
  var curlyBraceCount = 0;
  for (var max = chunk.length; state.index < max; state.index++) {
    character = chunk[state.index];
    if (character === CHAR_BLOCK_START) {
      hasFoundTheCurlyBraces = true;
      curlyBraceCount++;
    } else if (character === CHAR_BLOCK_END) {
      curlyBraceCount--;
    }

    if (hasFoundTheCurlyBraces && curlyBraceCount === 0) {
      break;
    }
  }
  return curlyBraceCount === 0;
}

function skipFunctionDefinition(chunk, state) {
  var start = state.index;
  var parenthesisNest = 1;
  var character = chunk[++state.index];
  while (character !== undefined && parenthesisNest) {
    if (character === CHAR_LEFT_PARENTHESIS) {
      parenthesisNest++;
    } else if (character === CHAR_RIGHT_PARENTHESIS) {
      parenthesisNest--;
    }

    character = chunk[++state.index];
  }

  while (character && character !== CHAR_BLOCK_START) {
    character = chunk[++state.index];
  }

  character = chunk[++state.index];
  var blockNest = 1;
  while (character !== undefined && blockNest) {
    if (character === CHAR_BLOCK_START) {
      blockNest++;
    } else if (character === CHAR_BLOCK_END) {
      blockNest--;
    }

    character = chunk[++state.index];
  }

  state.index--;
}

function parseRepositoryClosure(chunk, state) {
  var out = [];
  var repository = deepParse(chunk, state, true, false);
  Object.keys(repository).map(function(item) {
    if (repository[item]) {
      out.push({type: item, data: repository[item]});
    } else {
      out.push({type: 'unknown', data: {name: item}});
    }
  });
  return out;
}

function fetchDefinedNameOrSkipFunctionDefinition(chunk, state) {
  var character = 0;
  var temp = '';
  var isVariableDefinition = true;
  for (var max = chunk.length; state.index < max; state.index++) {
    character = chunk[state.index];

    if (character === CHAR_EQUALS) {
      // Variable definition, break and return name
      break;
    } else if (character === CHAR_LEFT_PARENTHESIS) {
      // Function definition, skip parsing
      isVariableDefinition = false;
      skipFunctionDefinition(chunk, state);
      break;
    }

    temp += String.fromCharCode(character);
  }

  if (isVariableDefinition) {
    var values = temp.trim().split(' ');
    return values[values.length - 1];
  } else {
    return '';
  }
}

function parseArray(chunk, state) {
  var character = 0;
  var temp = '';
  for (var max = chunk.length; state.index < max; state.index++) {
    character = chunk[state.index];
    if (character === CHAR_ARRAY_START) {
      continue;
    } else if (character === CHAR_ARRAY_END) {
      break;
    }
    temp += String.fromCharCode(character);
  }

  return temp.split(',').map(function(item) {
    return trimWrappingQuotes(item.trim());
  });
}

function skipFunctionCall(chunk, state) {
  var openParenthesisCount = 0;
  var character = '';
  for (var max = chunk.length; state.index < max; state.index++) {
    character = chunk[state.index];
    if (character === CHAR_LEFT_PARENTHESIS) {
      openParenthesisCount++;
    } else if (character === CHAR_RIGHT_PARENTHESIS) {
      openParenthesisCount--;
    }

    if (openParenthesisCount === 0) {
      break;
    }
  }
  return openParenthesisCount === 0;
}

function isKeyword(string) {
  return string === KEYWORD_DEF || string === KEYWORD_IF || string === KEYWORD_STRING;
}

function isSingleLineComment(startOfComment) {
  return startOfComment === '//';
}

function addValueToStructure(structure, currentKey, value) {
  if (currentKey) {
    if (structure.hasOwnProperty(currentKey)) {
      if (structure[currentKey].constructor === Array) {
        structure[currentKey].push(getRealValue(value));
      } else {
        var oldValue = structure[currentKey];
        structure[currentKey] = [oldValue, getRealValue(value)];
      }
    } else {
      structure[currentKey] = getRealValue(value);
    }
  }
}

function getRealValue(value) {
  if (value === 'true' || value === 'false') { // booleans
    return value === 'true';
  }

  return value;
}

function isDelimiter(character) {
  return character === CHAR_SPACE || character === CHAR_EQUALS;
}

function isWhitespace(character) {
  return WHITESPACE_CHARACTERS.hasOwnProperty(character);
}

function trimWrappingQuotes(string) {
  var firstCharacter = string.slice(0, 1);
  if (firstCharacter === '"') {
    return string.replace(/^"([^"]+)"[,;\r ]*$/g, '$1');
  } else if (firstCharacter === '\'') {
    return string.replace(/^'([^']+)'[,;\r ]*$/g, '$1');
  }
  return string;
}

function isStartOfComment(snippet) {
  return snippet === '/*' || snippet === '//';
}

function isEndOfMultiLineComment(comment) {
  return comment.indexOf('*/') != -1;
}

function parse(readableStream) {
  return new Promise(function(resolve, reject) {
    var out = {};
    readableStream.on('data', function(chunk) {
      // console.log("parsing chunk in data: %s", chunk);
      var state = {
        index: 0,
        quote: {
          open: false,
          char: 0,
          flipStatus: function() {
            this.open = !this.open;
          },
          setQuoteChar: function(char) {
            this.char = char;
          },
          equalsQuoteChar: function(char) {
            return this.char === char;
          }
        },
        evaluation: {
            evalDependenciesOnly: true,
            parsingDependencies: false,
            parsing: false,
            brace: false,

            setEvalDependenciesOnly: function(depOnly) {
                this.evalDependenciesOnly = depOnly;
            },
            setParsingDependenciesStart: function() {
                this.parsingDependencies = true;
            },
            setParsingDependenciesEnd: function() {
                this.parsingDependencies = false;
            },
            setParsingStart: function() {
                this.parsing = true;
            },
            setParsingEnd: function() {
                this.parsing = false;
            },
            setBraceStart: function() {
                this.brace = true;
            },
            setBraceEnd: function() {
                this.brace = false;
            },
            isParsingEnd: function(character) {
                return (CHAR_EVAL_END.indexOf(character) > -1);
            },
            isQuote: function(character) {
                return (character == CHAR_SINGLE_QUOTE) || (character == CHAR_DOUBLE_QUOTE);
            },
            evaluateVariable: function(str) {
                if (ext_variables.hasOwnProperty(str)) {
                    return ext_variables[str];
                } else {
                    var estr = '$' + str;
                    // console.log("%s not found in ext variables, evaluation failed, using %s instead!", str, estr);
                    return estr;
                }
            }
        },
        comment: {
          parsing: false,
          singleLine: false,
          multiLine: false,

          setSingleLine: function() {
            this._setCommentState(true, false);
          },
          setMultiLine: function() {
            this._setCommentState(false, true);
          },
          reset: function() {
            this._setCommentState(false, false);
          },
          _setCommentState: function(singleLine, multiLine) {
            this.singleLine = singleLine;
            this.multiLine = multiLine;
            this.parsing = singleLine || multiLine;
          }
        }
      };
      out = deepParse(chunk, state, false, undefined);
    });

    readableStream.on('end', function() {
      // console.log("dumping from end, out variable");
      dumpStructureContent(out, true);
      // console.log("dumping from end, ext variable");
      dumpStructureContent(ext_variables, true);
      resolve(out);
    });
    readableStream.on('error', function(error) {
      reject('Error parsing stream: ' + error);
    });
  });
}

function parseText(text) {
  var textAsStream = new stream.Readable();
  textAsStream._read = function noop() {};
  textAsStream.push(text);
  textAsStream.push(null);
  return parse(textAsStream);
}

function parseFile(path, rootPaths) {
  rootPaths = rootPaths || null;
  // parse the root file to get ext_variables values
  if (rootPaths) {
    for (var index=0; index < rootPaths.length; index++) {
      // console.log('parsing: %s', rootPaths[index]);
      parse(fs.createReadStream(rootPaths[index]));
    }
    // console.log('dumping ext variables parsed from %s', rootPaths);
    dumpStructureContent(ext_variables, true);
  }

  // read the file twice, to first get ext_variables! because the buildscript may be placed below the dependencies!
  parse(fs.createReadStream(path));

  var stream = fs.createReadStream(path);
  return parse(stream);
}

module.exports = {
  parseText: parseText,
  parseFile: parseFile
};
