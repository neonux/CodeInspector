/* vim:set ts=2 sw=2 sts=2 et: */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Style Editor code.
 *
 * The Initial Developer of the Original Code is Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Cedric Vivier <cedricv@neonux.com> (original author)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

const EXPORTED_SYMBOLS = ["CodeInspectorChrome"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("chrome://CodeInspector/content/AdaptiveSplitView.jsm");
Cu.import("chrome://CodeInspector/content/Coverage.jsm");
Cu.import("chrome://CodeInspector/content/StyleEditorUtil.jsm");

const SCRIPT_TEMPLATE = "script";

const LOAD_ERROR = "load-error";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const POLLING_INTERVAL_MS = 500;


/**
 * CodeInspectorChrome constructor.
 *
 * The 'chrome' of the Coverage Tool is all the UI that populates and updates
 * the actual coverage reports.
 *
 * @param DOMElement aRoot
 *        Element that owns the chrome UI.
 * @param DOMWindow aContentWindow
 *        Optional content DOMWindow to attach to this chrome.
 *        Default: the currently active browser tab content window.
 */
function CodeInspectorChrome(aRoot, aContentWindow)
{
  assert(aRoot, "Argument 'aRoot' is required to initialize CodeInspectorChrome.");

  this._root = aRoot;
  this._document = this._root.ownerDocument;
  this._window = this._document.defaultView;

  this._coverage = null;
  this._scripts = {};
  this._listeners = []; // @see addChromeListener

  this._contentWindow = null;
  this._isContentAttached = false;

  let initializeUI = function (aEvent) {
    if (aEvent) {
      this._window.removeEventListener("load", initializeUI, false);
    }

    let viewRoot = this._root.parentNode.querySelector(".splitview-root");
    this._view = new AdaptiveSplitView(viewRoot);

    this._setupChrome();

    // attach to the content window
    this.contentWindow = aContentWindow || getCurrentBrowserTabContentWindow();
  }.bind(this);

  if (this._document.readyState == "complete") {
    initializeUI();
  } else {
    this._window.addEventListener("load", initializeUI, false);
  }
}

CodeInspectorChrome.prototype = {
  /**
   * Retrieve the content window attached to this chrome.
   *
   * @return DOMWindow
   */
  get contentWindow() this._contentWindow,

  /**
   * Set the content window attached to this chrome.
   * Content attach or detach events/notifications are triggered after the
   * operation is complete (possibly asynchronous if the content is not fully
   * loaded yet).
   *
   * @param DOMWindow aContentWindow
   * @see addChromeListener
   */
  set contentWindow(aContentWindow)
  {
    if (this._contentWindow == aContentWindow) {
      return; // no change
    }

    this._contentWindow = aContentWindow;

    if (!aContentWindow) {
      this._disableChrome();
      return;
    }

    let onContentUnload = function () {
      aContentWindow.removeEventListener("unload", onContentUnload, false);
      if (this.contentWindow == aContentWindow) {
        this.contentWindow = null; // detach
      }
    }.bind(this);
    aContentWindow.addEventListener("unload", onContentUnload, false);

    if (aContentWindow.document.readyState == "complete") {
      this._populateChrome();
      return;
    } else {
      let onContentReady = function () {
        aContentWindow.removeEventListener("load", onContentReady, false);
        this._populateChrome();
      }.bind(this);
      aContentWindow.addEventListener("load", onContentReady, false);
    }
  },

  /**
   * Retrieve the content document attached to this chrome.
   *
   * @return DOMDocument
   */
  get contentDocument()
  {
    return this._contentWindow ? this._contentWindow.document : null;
  },

  /**
    * Retrieve whether the content has been attached and StyleEditor instances
    * exist for all of its stylesheets.
    *
    * @return boolean
    * @see addChromeListener
    */
  get isContentAttached() this._isContentAttached,

  /**
   * Retrieve an object with coverage data for each script that currently has
   * reports available. Every script uri is a key of the object.
   *
   * @return object
   */
  get scripts()
  {
    let scripts = {};
    this._scripts.forEach(function (aScript) {
      scripts[aScript.filename] = aScript;
    });
    return scripts;
  },

  /**
   * Add a listener for CodeInspectorChrome events.
   *
   * The listener implements ICodeInspectorChromeListener := {
   *   onContentAttach:        Called when a content window has been attached.
   *                           Arguments: (CodeInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onContentDetach:        Called when the content window has been detached.
   *                           Arguments: (CodeInspectorChrome aChrome)
   *                           @see contentWindow
   *
   *   onScriptAdded:          Called when a script has been added to the UI.
   *                           Arguments (CodeInspectorChrome aChrome,
   *                                      string scriptUri)
   * }
   *
   * All listener methods are optional.
   *
   * @param IStyleEditorChromeListener aListener
   * @see removeChromeListener
   */
  addChromeListener: function CC_addChromeListener(aListener)
  {
    this._listeners.push(aListener);
  },

  /**
   * Remove a listener for Chrome events from the current list of listeners.
   *
   * @param IStyleEditorChromeListener aListener
   * @see addChromeListener
   */
  removeChromeListener: function CC_removeChromeListener(aListener)
  {
    let index = this._listeners.indexOf(aListener);
    if (index != -1) {
      this._listeners.splice(index, 1);
    }
  },

  /**
   * Trigger named handlers in StyleEditorChrome listeners.
   *
   * @param string aName
   *        Name of the event to trigger.
   * @param Array aArgs
   *        Optional array of arguments to pass to the listener(s).
   * @see addActionListener
   */
  _triggerChromeListeners: function CC__triggerChromeListeners(aName, aArgs)
  {
    // insert the origin Chrome instance as first argument
    if (!aArgs) {
      aArgs = [this];
    } else {
      aArgs.unshift(this);
    }

    // trigger all listeners that have this named handler
    for (let i = 0; i < this._listeners.length; ++i) {
      let listener = this._listeners[i];
      let handler = listener["on" + aName];
      if (handler) {
        handler.apply(listener, aArgs);
      }
    }
  },

  /**
   * Set up the chrome UI. Install event listeners and so on.
   */
  _setupChrome: function CC__setupChrome()
  {
    // wire up UI elements
    wire(this._view.rootElement, ".coverage-tool-trackButton", function onTrackButton() {
      this._dumpCoverageData();
    }.bind(this));
  },

  /**
   * Reset the chrome UI to an empty state.
   */
  _resetChrome: function CC__resetChrome()
  {
//FIXME:
    if (this._coverage) {
      this._coverage.removeListener(this);
    }
    this._coverage = null;
    this._scripts = {};

    this._view.removeAll();
  },

  /**
   * Populate the chrome UI according to the content document.
   *
   * @see StyleEditor._setupShadowStyleSheet
   */
  _populateChrome: function CC__populateChrome()
  {
    this._resetChrome();

    this._document.title = _("chromeWindowTitle",
          this.contentDocument.title || this.contentDocument.location.href);

    this._coverageData = {};
    this._coverage = new Coverage();
    this._coverage.addListener(this);

    this._triggerChromeListeners("ContentAttach");

    this._dumpCoverageData();
  },

  /**
   * TODO:
   */
  _dumpCoverageData: function CC__dumpCoverageDAta()
  {
    let utils = this.contentWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                  getInterface(Ci.nsIDOMWindowUtils);
    let dump = utils.dumpCompartmentBytecode();
    this._coverage.parseData(dump);
  },

  /**
   * Disable all UI, effectively making editors read-only.
   * This is automatically called when no content window is attached.
   *
   * @see contentWindow
   */
  _disableChrome: function CC__disableChrome()
  {
    this._triggerChromeListeners("ContentDetach");
  },

  /**
   * Retrieve the summary element for a given script uri.
   *
   * @param object aScriptData
   * @return DOMElement
   *         Item's summary element or null if not found.
   * @see AdaptiveSplitView
   */
  getSummaryElementForScript: function CC_getSummaryElementForScript(aScriptData)
  {
    return this._scripts[aScriptData.filename].$summary;
  },

  /**
   * Update split view summary of given script uri.
   *
   * @param object aScriptData
   * @param DOMElement aSummary
   *        Optional item's summary element to update. If none, item corresponding
   *        to passed aEditor is used.
   */
  _updateSummaryForScript: function CC__updateSummaryForScript(aScriptData, aSummary)
  {
    let summary = aSummary || this.getSummaryElementForScript(aScriptData);

    let ratio = aScriptData.covered / aScriptData.$LOC;
    let percentile = "percentile-bad";
    if (ratio >= 0.8) {
      percentile = "percentile-good";
    } else if (ratio > 0.5) {
      percentile = "percentile-average";
    }

    this._view.setItemClassName(summary, percentile);

    text(summary, ".script-name", this._getFriendlyName(aScriptData));
    text(summary, ".script-covered",
      _("script-covered.label",
        aScriptData.covered,
        Math.round(ratio * 100.0),
        aScriptData.$LOC));

//    text(summary, ".script-error-message", aEditor.errorMessage);
  },

  /**
   * Get a user-friendly name for the script.
   *
   * @return string
   */
  _getFriendlyName: function CC__getFriendlyName(aScriptData)
  {
    if (aScriptData.$friendlyName) {
      return aScriptData.$friendlyName;
    }

    let scriptURI = aScriptData.filename;
    let contentURI = this.contentDocument.baseURIObject;
    let contentURIScheme = contentURI.scheme;
    let contentURILeafIndex = contentURI.specIgnoringRef.lastIndexOf("/");
    contentURI = contentURI.specIgnoringRef;

    // get content base URI without leaf name (if any)
    if (contentURILeafIndex > contentURIScheme.length) {
      contentURI = contentURI.substring(0, contentURILeafIndex + 1);
    }

    // avoid verbose repetition of absolute URI when the style sheet URI
    // is relative to the content URI
    aScriptData.$friendlyName = (scriptURI.indexOf(contentURI) == 0)
                                ? scriptURI.substring(contentURI.length)
                                : scriptURI;
    return aScriptData.$friendlyName;
  },

  /**
   * Retrieve the script source from the cache or from a local file.
   *
   * @param object aScriptData
   */
  _loadSource: function CC__loadSource(aScriptData)
  {
    let uri = aScriptData.filename;
    let scheme = Services.io.extractScheme(uri);
    switch (scheme) {
      case "file":
      case "chrome":
      case "resource":
        this._loadSourceFromFile(aScriptData);
        break;
      default:
        this._loadSourceFromCache(aScriptData);
        break;
    }
  },

  /**
   * Load source from a file or file-like resource.
   *
   * @param string aScriptData
   */
  _loadSourceFromFile: function CC__loadSourceFromFile(aScriptData)
  {
    let aHref = aScriptData.filename; //FIXME:
    try {
      NetUtil.asyncFetch(aHref, function onFetch(aStream, aStatus) {
        if (!Components.isSuccessCode(aStatus)) {
          return this._signalError(LOAD_ERROR);
        }
        let source = NetUtil.readInputStreamToString(aStream, aStream.available());
        aStream.close();
        this._onSourceLoad(aScriptData, source);
      }.bind(this));
    } catch (ex) {
      this._signalError(LOAD_ERROR);
    }
  },

  /**
   * Load source from the HTTP cache.
   *
   * @param string aScriptData
   */
  _loadSourceFromCache: function CC__loadSourceFromCache(aScriptData)
  {
    let aHref = aScriptData.filename; //FIXME:
    try {
      let cacheService = Cc["@mozilla.org/network/cache-service;1"]
                           .getService(Ci.nsICacheService);
      let session = cacheService.createSession("HTTP", Ci.nsICache.STORE_ANYWHERE, true);
      session.doomEntriesIfExpired = false;
      session.asyncOpenCacheEntry(aHref, Ci.nsICache.ACCESS_READ, {
        onCacheEntryAvailable: function onCacheEntryAvailable(aEntry, aMode, aStatus) {
          if (!Components.isSuccessCode(aStatus)) {
            return this._signalError(LOAD_ERROR);
          }

          let source = "";
          let stream = aEntry.openInputStream(0);
          let head = aEntry.getMetaDataElement("response-head");

          if (/Content-Encoding:\s*gzip/i.test(head)) {
            let converter = Cc["@mozilla.org/streamconv;1?from=gzip&to=uncompressed"]
                              .createInstance(Ci.nsIStreamConverter);
            converter.asyncConvertData("gzip", "uncompressed", {
              onDataAvailable: function onDataAvailable(aRequest, aContext, aUncompressedStream, aOffset, aCount) {
                source += NetUtil.readInputStreamToString(aUncompressedStream, aCount);
              }
            }, this);
            while (stream.available()) {
              converter.onDataAvailable(null, this, stream, 0, stream.available());
            }
          } else {
            // uncompressed data
            while (stream.available()) {
              source += NetUtil.readInputStreamToString(stream, stream.available());
            }
          }

          stream.close();
          aEntry.close();
          this._onSourceLoad(aScriptData, source);
        }.bind(this)
      });
    } catch (ex) {
      this._signalError(LOAD_ERROR);
    }
  },

  /**
   * Called when source has been loaded.
   *
   * @param object aScriptData
   * @param string aSourceText
   */
  _onSourceLoad: function CC__onSourceLoad(aScriptData, aSourceText)
  {
    aScriptData.$sourceText = aSourceText;
    aScriptData.$LOC = 0;

    let item = this._view.appendTemplatedItem(SCRIPT_TEMPLATE, {
      data: {
        scriptData: aScriptData
      },
      onCreate: function ASV_onItemCreate(aSummary, aDetails, aData) {
        let scriptData = aData.scriptData;
        scriptData.$summary = aSummary;

        wire(aSummary, ".script-mode-selectBox", {
          events: {
            "change": function onModeChange(aEvent) {
              aEvent.stopPropagation();

              let sourceView = aDetails.querySelector(".script-source");
              sourceView.className = "script-source " + aEvent.target.value;
            }
          }
        });

        // autofocus first script
        if (aSummary.parentNode.firstChild == aSummary) {
          this._view.activeSummary = aSummary;
        }

        aSummary.addEventListener("focus", function onSummaryFocus(aEvent) {
          if (aEvent.target == aSummary) {
            // autofocus the script name
            aSummary.querySelector(".script-name").focus();
          }
        }, false);

        this._populateSource(scriptData, aDetails);
        this._updateSummaryForScript(scriptData, aSummary);

        this._triggerChromeListeners("ScriptAdded", [scriptData]);

        this._window.setInterval(function updateCoverageData() {
          this._dumpCoverageData();
        }.bind(this), POLLING_INTERVAL_MS);
      }.bind(this)
    });
  },

  /**
   * TODO:
   */
  _populateSource: function CC__populateSource(aScriptData, aDetails)
  {
    let document = aDetails.ownerDocument;
    let sourceView = aDetails.querySelector(".script-source");

    let mode = this._document.querySelector(".script-mode-selectBox").value;
    sourceView.className = "script-source " + mode;

    let lineno = 1;
    for each (let line in aScriptData.$sourceText.split(/\r?\n/)) {
      let lineView = document.createElementNS(HTML_NS, "p");
      let gutter = document.createElementNS(HTML_NS, "span");
      gutter.className = "gutter";
      gutter.appendChild(document.createTextNode(lineno));
      lineView.appendChild(gutter);
      let code = document.createElementNS(HTML_NS, "code");
      code.appendChild(document.createTextNode(line));
      lineView.appendChild(code);

      lineView.setAttribute("data-lineno", lineno);

      let lineData = aScriptData.lines[lineno - 1];
      if (lineData) {
        aScriptData.$LOC++;
        this._updateLine(lineView, lineno, lineData);
      }

      sourceView.appendChild(lineView);
      lineno++;
    }
  },

  /**
   * TODO:
   */
  _updateSource: function CC__updateSource(aScriptData, aLineNo, aLineData)
  {
    let summary = this.getSummaryElementForScript(aScriptData);
    //FIXME: ASV helper!
    let details = summary.getUserData("splitview-binding")._details;
    let sourceView = details.querySelector(".script-source");
    let lineElement = sourceView.children[aLineNo - 1];

    this._updateLine(lineElement, aLineNo, aLineData);

    if (aLineNo != 1) { //inline workaround FIXME:
      let now = Date.now();
      if (!this._lastJumpTime ||
          now - this._lastJumpTime > POLLING_INTERVAL_MS) {
        let recents = sourceView.querySelectorAll(".recent");
        for (let i = 0; i < recents.length; ++i) {
          recents[i].classList.remove("recent");
        }

        this._view.activeSummary = summary;
        (lineElement.previousElementSibling || lineElement).scrollIntoView();
        this._lastJumpTime = Date.now();
      }
    }

    lineElement.classList.add("recent");
  },

  _updateLine: function CC__updateLine(aLineElement, aLineNo, aLineData)
  {
    aLineElement.setAttribute("title",
      _("executionCount.label", aLineNo, aLineData.counts[0]));
    aLineElement.className = aLineData.coverage;
  },

  //FIXME:
  _signalError: function CC__signalError(aCode)
  {
    log("ERROR", aCode);
  },

  /**
   * ICoverageListener implementation
   * @See Coverage.addListener
   */

  /**
   * Called a new script has been covered.
   *
   * @param Coverage aCoverage
   * @param string aUri
   * @param object aScriptData
   */
  onNewScript: function C_onNewScript(aCoverage, aUri, aScriptData)
  {
    if (/\.html$/.test(aScriptData.filename)) {
      return; // ignore inline scripts for now FIXME:
    }
    this._scripts[aScriptData.filename] = aScriptData;
    this._loadSource(aScriptData);
  },

  /**
   * Called when script data has been updated
   *
   * @param Coverage aCoverage
   * @param string aUri
   * @param object aScriptData
   */
  onScriptUpdate: function C_onScriptUpdate(aCoverage, aUri, aScriptData)
  {
    this._updateSummaryForScript(aScriptData);
  },

  /**
   * Called when line data has been updated
   *
   * @param Coverage aCoverage
   * @param string aUri
   * @param object aLineData
   */
  onLineUpdate: function C_onLineUpdate(aCoverage, aUri, aLineNo, aLineData)
  {
    let scriptData = this._scripts[aUri];
    this._updateSource(scriptData, aLineNo, aLineData);
  }
};
