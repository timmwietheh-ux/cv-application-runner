/* ==========================================================================
   pdf-viewer.js — Continuous multi-page PDF.js viewer.

   Renders every page of the document into one smoothly scrollable vertical
   stream, renders lazily around the viewport, keeps memory bounded by
   releasing off-screen canvases, tracks the current page while scrolling,
   preserves the reading position across recompiles and zoom changes, and
   exposes exact PDF-point coordinates for bidirectional SyncTeX.
   ========================================================================== */
(function (global) {
  "use strict";

  /* PDF points -> CSS pixels at 96 dpi. */
  var CSS_UNITS = 96 / 72;
  /* Render this far outside the viewport (px) before a page is needed. */
  var RENDER_MARGIN = 900;
  /* Release canvases further away than this (px) to bound memory. */
  var RELEASE_MARGIN = 2400;
  var MAX_DPR = 2;
  var MAX_CANVAS_PIXELS = 8 * 1024 * 1024;

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function ContinuousPdfViewer(options) {
    this.container = options.container; /* the scrolling element */
    this.pagesEl = options.pagesEl; /* flex column holding the pages */
    this.onPageChange = options.onPageChange || function () {};
    this.onZoomChange = options.onZoomChange || function () {};
    this.onInverseSync = options.onInverseSync || function () {};
    this.onStatus = options.onStatus || function () {};
    this.onHistoryChange = options.onHistoryChange || function () {};

    this.pdfDoc = null;
    this.pageViews = [];
    this.baseViewports = [];
    this.scale = 1;
    this.zoomMode = "page-width";
    this.currentPage = 1;
    this.observer = null;
    this.renderQueue = [];
    this.activeRenders = 0;
    this.maxConcurrentRenders = 2;
    this.loadToken = 0;
    this.history = [];
    this._scrollRaf = 0;
    this._scrollTimer = 0;
    this._scrollPending = false;
    this._resizeTimer = 0;

    this._bindEvents();
  }

  ContinuousPdfViewer.prototype._bindEvents = function () {
    var self = this;

    this.container.addEventListener(
      "scroll",
      function () {
        if (self._scrollPending) return;
        self._scrollPending = true;
        var done = false;
        var run = function () {
          if (done) return;
          done = true;
          self._scrollPending = false;
          cancelAnimationFrame(self._scrollRaf);
          clearTimeout(self._scrollTimer);
          self._updateCurrentPage();
        };
        self._scrollRaf = requestAnimationFrame(run);
        /* rAF is throttled to a standstill in hidden or background tabs, so a
           timer backs it up; otherwise scrolling would stop updating there. */
        self._scrollTimer = setTimeout(run, 150);
      },
      { passive: true }
    );

    /* Inverse SyncTeX: double-click anywhere in the stream. */
    this.container.addEventListener("dblclick", function (event) {
      var pageEl = event.target.closest ? event.target.closest(".pdf-page") : null;
      if (!pageEl) {
        /* The click landed in the gap or the side padding: use the nearest
           page instead of silently doing nothing. */
        var nearest = self._pageAtClientY(event.clientY);
        if (!nearest) return;
        pageEl = nearest.div;
      }
      var pageNumber = parseInt(pageEl.getAttribute("data-page-number"), 10);
      var rect = pageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var base = self.baseViewports[pageNumber - 1];
      if (!base) return;
      /* Map the click back into PDF points (origin: top-left of the page). */
      var xPt = clamp((event.clientX - rect.left) / rect.width, 0, 1) * base.width;
      var yPt = clamp((event.clientY - rect.top) / rect.height, 0, 1) * base.height;
      self.onInverseSync(pageNumber, xPt, yPt, self._wordAtPoint(event));
    });

    /* Ctrl + wheel zooms, like every other document viewer. */
    this.container.addEventListener(
      "wheel",
      function (event) {
        if (!event.ctrlKey) return;
        event.preventDefault();
        var factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        self.setZoom(clamp(self.scale * factor, 0.25, 6) / CSS_UNITS);
      },
      { passive: false }
    );

    if (global.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(function () {
        if (self._resizeTimer) clearTimeout(self._resizeTimer);
        self._resizeTimer = setTimeout(function () {
          if (self.pdfDoc && typeof self.zoomMode === "string") self.setZoom(self.zoomMode);
        }, 120);
      });
      this._resizeObserver.observe(this.container);
    }
  };

  /** Return the rendered word under a PDF double-click when the text layer has one. */
  ContinuousPdfViewer.prototype._wordAtPoint = function (event) {
    var node = null;
    var offset = 0;
    if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (position) { node = position.offsetNode; offset = position.offset; }
    } else if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) { node = range.startContainer; offset = range.startOffset; }
    }
    if (!node || node.nodeType !== 3) return { word: "" };
    var parent = node.parentElement;
    if (!parent || !parent.closest(".textLayer")) return { word: "" };
    var text = node.nodeValue || "";
    if (!text) return { word: "" };
    offset = clamp(offset, 0, text.length);
    if (offset === text.length && offset > 0) offset -= 1;

    function wordChar(char) {
      if (!char) return false;
      try { return /[\p{L}\p{N}_'’-]/u.test(char); }
      catch (err) { return /[A-Za-z0-9_'’-]/.test(char); }
    }

    var start = offset;
    var end = offset;
    while (start > 0 && wordChar(text.charAt(start - 1))) start -= 1;
    while (end < text.length && wordChar(text.charAt(end))) end += 1;
    var word = text.slice(start, end).replace(/^[\s'’-]+|[\s'’-]+$/g, "");
    // PDF.js splits lines at font changes, ligatures and mathematical symbols.
    // Include neighbouring spans in the same column, retaining the click offset.
    var rect = parent.getBoundingClientRect();
    var spans = Array.from(parent.closest('.textLayer').querySelectorAll('span'));
    var nearby = spans.filter(function (span) {
      var box = span.getBoundingClientRect();
      return box.height && Math.abs(box.top - rect.top) < Math.max(12, rect.height * 3.5) &&
        box.left < rect.right + rect.height * 2 && box.right > rect.left - rect.height * 2;
    });
    var context = '', clickedOffset = start, previous = null;
    nearby.forEach(function (span) {
      var value = span.textContent || '', box = span.getBoundingClientRect();
      var newLine = previous && Math.abs(box.top - previous.top) > rect.height * 0.6;
      if (context && newLine && /[A-Za-z]-$/.test(context) && /^[a-z]/.test(value)) context = context.slice(0, -1);
      else if (context && (newLine || !previous || box.left - previous.right > rect.height * 0.15)) context += ' ';
      if (span === parent) clickedOffset = context.length + start;
      context += value;
      previous = box;
    });
    var from = Math.max(0, clickedOffset - 220);
    return { word: word, text: context.slice(from, from + 500), offset: clickedOffset - from };
  };

  /* ---------------------------------------------------------------- load */

  ContinuousPdfViewer.prototype.load = function (url, opts) {
    var self = this;
    opts = opts || {};
    var token = ++this.loadToken;
    var restore = opts.preservePosition ? this._capturePosition() : null;
    // Keep the old pages on screen until the new ones are painted.
    var frozen = opts.preservePosition ? this._freeze() : null;

    return global.pdfjsLib
      .getDocument({ url: url, cMapPacked: true, isEvalSupported: false })
      .promise.then(function (doc) {
        if (token !== self.loadToken) {
          doc.destroy();
          return null;
        }
        var pagePromises = [];
        for (var i = 1; i <= doc.numPages; i += 1) pagePromises.push(doc.getPage(i));
        return Promise.all(pagePromises).then(function (pages) {
          if (token !== self.loadToken) { doc.destroy(); return null; }
          self._teardown();
          self.pdfDoc = doc;
          self.baseViewports = pages.map(function (page) {
            var vp = page.getViewport({ scale: CSS_UNITS });
            return { width: vp.width / CSS_UNITS, height: vp.height / CSS_UNITS, page: page };
          });
          self._buildLayout();
          self.setZoom(self.zoomMode, { silent: true });
          if (restore) self._restorePosition(restore);
          self._updateCurrentPage(true);
          self.onStatus({ loaded: true, numPages: doc.numPages });
          if (frozen) self._thaw(frozen, token);
          return doc;
        }).catch(function (error) {
          if (self.pdfDoc !== doc) doc.destroy();
          throw error;
        });
      })
      .catch(function (err) {
        if (frozen) self._removeFreeze(frozen);
        if (token !== self.loadToken) return null;
        /* A failed reload (a PDF still being written) keeps the old document. */
        self.onStatus({ loaded: !!self.pdfDoc, kept: !!self.pdfDoc,
          error: err && err.message ? err.message : String(err) });
        return null;
      });
  };

  /* Copy the visible page bitmaps into an overlay: a reload never flashes. */
  ContinuousPdfViewer.prototype._freeze = function () {
    var host = this.container.parentNode;
    if (!host || !this.pageViews.length) return null;
    var box = this.container.getBoundingClientRect();
    var hostBox = host.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    var overlay = document.createElement("div");
    overlay.className = "pdf-freeze";
    overlay.style.left = box.left - hostBox.left + "px";
    overlay.style.top = box.top - hostBox.top + "px";
    overlay.style.width = this.container.clientWidth + "px";
    overlay.style.height = this.container.clientHeight + "px";
    var copied = 0;
    this.pageViews.forEach(function (pv) {
      if (!pv.canvas || !pv.canvas.width) return;
      var rect = pv.canvas.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) return;
      var copy = document.createElement("canvas");
      copy.width = pv.canvas.width;
      copy.height = pv.canvas.height;
      try { copy.getContext("2d").drawImage(pv.canvas, 0, 0); } catch (err) { return; }
      copy.style.left = rect.left - box.left + "px";
      copy.style.top = rect.top - box.top + "px";
      copy.style.width = rect.width + "px";
      copy.style.height = rect.height + "px";
      overlay.appendChild(copy);
      copied += 1;
    });
    if (!copied) return null;
    host.appendChild(overlay);
    var self = this;
    // Scrolling during the swap would move the real pages under a still image.
    overlay._onScroll = function () { self._removeFreeze(overlay); };
    this.container.addEventListener("wheel", overlay._onScroll, { passive: true });
    this.container.addEventListener("mousedown", overlay._onScroll);
    return overlay;
  };

  ContinuousPdfViewer.prototype._removeFreeze = function (overlay) {
    if (!overlay || overlay._removed) return;
    overlay._removed = true;
    this.container.removeEventListener("wheel", overlay._onScroll);
    this.container.removeEventListener("mousedown", overlay._onScroll);
    overlay.classList.add("leaving");
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
  };

  ContinuousPdfViewer.prototype._visibleRendered = function () {
    var top = this.container.scrollTop;
    var bottom = top + this.container.clientHeight;
    var any = false;
    for (var i = 0; i < this.pageViews.length; i += 1) {
      var pv = this.pageViews[i];
      var pageTop = pv.div.offsetTop;
      var pageBottom = pageTop + pv.div.offsetHeight;
      if (pageBottom < top || pageTop > bottom) continue;
      any = true;
      if (pv.renderedScale !== this.scale) return false;
    }
    return any;
  };

  ContinuousPdfViewer.prototype._thaw = function (overlay, token) {
    var self = this;
    var started = Date.now();
    (function poll() {
      if (overlay._removed) return;
      if (token !== self.loadToken || self._visibleRendered() || Date.now() - started > 4000) {
        self._removeFreeze(overlay);
        return;
      }
      setTimeout(poll, 40);
    })();
  };

  ContinuousPdfViewer.prototype._teardown = function () {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.renderQueue = [];
    this.pageViews.forEach(function (pv) {
      if (pv.renderTask) {
        try {
          pv.renderTask.cancel();
        } catch (e) {
          /* already finished */
        }
      }
    });
    this.pageViews = [];
    this.pagesEl.innerHTML = "";
    if (this.pdfDoc) {
      try {
        this.pdfDoc.destroy();
      } catch (e) {
        /* ignore */
      }
      this.pdfDoc = null;
    }
  };

  /* -------------------------------------------------------------- layout */

  ContinuousPdfViewer.prototype._buildLayout = function () {
    var self = this;
    var fragment = document.createDocumentFragment();

    this.baseViewports.forEach(function (base, index) {
      var pageNumber = index + 1;
      var div = document.createElement("div");
      div.className = "pdf-page";
      div.setAttribute("data-page-number", String(pageNumber));

      var label = document.createElement("div");
      label.className = "pdf-page-label";
      label.textContent = String(pageNumber);
      div.appendChild(label);

      fragment.appendChild(div);
      self.pageViews.push({
        num: pageNumber,
        div: div,
        canvas: null,
        textLayer: null,
        linkLayer: null,
        renderTask: null,
        renderedScale: 0,
        rendering: false,
      });
    });

    this.pagesEl.appendChild(fragment);

    this.observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var pv = self.pageViews[parseInt(entry.target.getAttribute("data-page-number"), 10) - 1];
          if (!pv) return;
          if (entry.isIntersecting) self._enqueueRender(pv);
        });
      },
      { root: this.container, rootMargin: RENDER_MARGIN + "px 0px" }
    );
    this.pageViews.forEach(function (pv) {
      self.observer.observe(pv.div);
    });
  };

  /* --------------------------------------------------------------- zoom */

  ContinuousPdfViewer.prototype._computeScale = function (mode) {
    if (!this.baseViewports.length) return CSS_UNITS;
    var maxWidth = 0;
    var maxHeight = 0;
    this.baseViewports.forEach(function (b) {
      if (b.width > maxWidth) maxWidth = b.width;
      if (b.height > maxHeight) maxHeight = b.height;
    });
    var availableWidth = Math.max(120, this.container.clientWidth - 48);
    var availableHeight = Math.max(120, this.container.clientHeight - 56);

    if (mode === "page-width") return availableWidth / maxWidth;
    if (mode === "page-fit") {
      return Math.min(availableWidth / maxWidth, availableHeight / maxHeight);
    }
    if (mode === "auto") return Math.min(availableWidth / maxWidth, 1.35 * CSS_UNITS);
    var numeric = parseFloat(mode);
    if (!isNaN(numeric)) return numeric * CSS_UNITS;
    return CSS_UNITS;
  };

  ContinuousPdfViewer.prototype.setZoom = function (mode, opts) {
    opts = opts || {};
    if (!this.pdfDoc) {
      this.zoomMode = mode;
      return;
    }
    var position = this._capturePosition();
    this.zoomMode = mode;
    this.scale = clamp(this._computeScale(mode), 0.15, 8);
    this._applyScale();
    if (position) this._restorePosition(position);
    if (!opts.silent) this.onZoomChange(this.scale / CSS_UNITS, this.zoomMode);
    this._updateCurrentPage(true);
  };

  ContinuousPdfViewer.prototype.getZoomPercent = function () {
    return Math.round((this.scale / CSS_UNITS) * 100);
  };

  ContinuousPdfViewer.prototype._applyScale = function () {
    var self = this;
    this.pageViews.forEach(function (pv, index) {
      var base = self.baseViewports[index];
      var width = Math.floor(base.width * self.scale);
      var height = Math.floor(base.height * self.scale);
      pv.div.style.width = width + "px";
      pv.div.style.height = height + "px";
      pv.div.style.setProperty("--scale-factor", String(self.scale));
      if (pv.highlight) self._positionHighlight(pv);
      /* Existing bitmaps are now the wrong resolution. */
      if (pv.renderedScale && Math.abs(pv.renderedScale - self.scale) > 0.001) {
        self._release(pv);
      }
    });
    this._sweep();
    this._requestVisible();
  };

  /* ------------------------------------------------------------- render */

  /* Is this page close enough to the viewport to be worth a bitmap? */
  ContinuousPdfViewer.prototype._isNear = function (pv) {
    var top = this.container.scrollTop - RENDER_MARGIN;
    var bottom = this.container.scrollTop + this.container.clientHeight + RENDER_MARGIN;
    var pageTop = pv.div.offsetTop;
    return pageTop + pv.div.offsetHeight >= top && pageTop <= bottom;
  };

  ContinuousPdfViewer.prototype._enqueueRender = function (pv) {
    if (pv.rendering || pv.renderedScale === this.scale) return;
    if (!this._isNear(pv)) return;
    if (this.renderQueue.indexOf(pv) === -1) this.renderQueue.push(pv);
    this._drainQueue();
  };

  /**
   * Queue every page near the viewport. IntersectionObserver only reports
   * *changes*, so after a zoom or a reload the already-visible pages need an
   * explicit nudge or the stream would stay blank.
   */
  ContinuousPdfViewer.prototype._requestVisible = function () {
    for (var i = 0; i < this.pageViews.length; i += 1) this._enqueueRender(this.pageViews[i]);
  };

  ContinuousPdfViewer.prototype._drainQueue = function () {
    var self = this;
    while (this.activeRenders < this.maxConcurrentRenders && this.renderQueue.length) {
      /* Nearest page to the viewport first. */
      var mid = this.container.scrollTop + this.container.clientHeight / 2;
      this.renderQueue.sort(function (a, b) {
        return (
          Math.abs(a.div.offsetTop + a.div.offsetHeight / 2 - mid) -
          Math.abs(b.div.offsetTop + b.div.offsetHeight / 2 - mid)
        );
      });
      var pv = this.renderQueue.shift();
      if (!pv || pv.rendering || pv.renderedScale === this.scale || !this._isNear(pv)) continue;
      this.activeRenders += 1;
      this._renderPage(pv).then(function () {
        self.activeRenders -= 1;
        self._drainQueue();
      });
    }
  };

  ContinuousPdfViewer.prototype._renderPage = function (pv) {
    var self = this;
    var base = this.baseViewports[pv.num - 1];
    if (!base) return Promise.resolve();

    var scaleAtStart = this.scale;
    var token = this.loadToken;
    var generation = pv.generation || 0;
    pv.rendering = true;
    pv.div.classList.add("is-loading");

    var viewport = base.page.getViewport({ scale: scaleAtStart });
    var dpr = Math.min(global.devicePixelRatio || 1, MAX_DPR);
    dpr = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));

    var canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    var ctx = canvas.getContext("2d", { alpha: false });

    var task = base.page.render({
      canvasContext: ctx,
      viewport: viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    pv.renderTask = task;

    return task.promise
      .then(function () {
        if (token !== self.loadToken || scaleAtStart !== self.scale || generation !== (pv.generation || 0)) return;
        if (pv.canvas && pv.canvas.parentNode) pv.canvas.parentNode.removeChild(pv.canvas);
        pv.div.appendChild(canvas);
        pv.canvas = canvas;
        pv.renderedScale = scaleAtStart;
        pv.div.classList.add("is-rendered");
        return self._renderTextLayer(pv, base.page, viewport, scaleAtStart, token, generation).then(function () {
          return self._renderLinkLayer(pv, base.page, viewport, scaleAtStart, token, generation);
        });
      })
      .catch(function (err) {
        if (err && err.name === "RenderingCancelledException") return;
        /* A failed page must not stall the queue. */
        if (global.console && err) console.warn("PDF page render failed", pv.num, err);
      })
      .then(function () {
        pv.rendering = false;
        pv.renderTask = null;
        if (pv.canvas !== canvas) { canvas.width = 0; canvas.height = 0; }
        pv.div.classList.remove("is-loading");
        /* The scale may have moved while this page was rasterising. */
        if (token === self.loadToken && pv.renderedScale !== self.scale) self._enqueueRender(pv);
      });
  };

  ContinuousPdfViewer.prototype._renderTextLayer = function (pv, page, viewport, scaleAtStart, token, generation) {
    var self = this;
    if (!global.pdfjsLib || !global.pdfjsLib.renderTextLayer) return Promise.resolve();
    return page
      .getTextContent()
      .then(function (textContent) {
        if (token !== self.loadToken || scaleAtStart !== self.scale || generation !== (pv.generation || 0)) return;
        if (pv.textLayer && pv.textLayer.parentNode) {
          pv.textLayer.parentNode.removeChild(pv.textLayer);
        }
        var layer = document.createElement("div");
        layer.className = "textLayer";
        pv.div.appendChild(layer);
        pv.textLayer = layer;
        var task = global.pdfjsLib.renderTextLayer({
          textContent: textContent,
          textContentSource: textContent,
          container: layer,
          viewport: viewport,
          textDivs: [],
        });
        pv.textTask = task;
        return task && task.promise ? task.promise : task;
      })
      .catch(function () {
        /* The text layer is a convenience; never let it break rendering. */
      });
  };

  /**
   * Clickable link layer: internal jumps (\ref, \cite, the table of contents)
   * and external URLs. Built from the page's own Link annotations rather than
   * pdf.js's AnnotationLayer so navigation stays inside this viewer.
   */
  ContinuousPdfViewer.prototype._renderLinkLayer = function (pv, page, viewport, scaleAtStart, token, generation) {
    var self = this;
    return page
      .getAnnotations({ intent: "display" })
      .then(function (annotations) {
        if (token !== self.loadToken || scaleAtStart !== self.scale || generation !== (pv.generation || 0)) return;
        if (pv.linkLayer && pv.linkLayer.parentNode) {
          pv.linkLayer.parentNode.removeChild(pv.linkLayer);
          pv.linkLayer = null;
        }
        var links = (annotations || []).filter(function (annotation) {
          return annotation.subtype === "Link" && (annotation.url || annotation.dest);
        });
        if (!links.length) return;

        var layer = document.createElement("div");
        layer.className = "pdf-link-layer";

        links.forEach(function (annotation) {
          var box = global.pdfjsLib.Util.normalizeRect(
            viewport.convertToViewportRectangle(annotation.rect)
          );
          var element = document.createElement(annotation.url ? "a" : "span");
          element.className = "pdf-link";
          element.style.left = box[0] + "px";
          element.style.top = box[1] + "px";
          element.style.width = Math.max(2, box[2] - box[0]) + "px";
          element.style.height = Math.max(2, box[3] - box[1]) + "px";

          if (annotation.url) {
            element.href = annotation.url;
            element.target = "_blank";
            element.rel = "noopener noreferrer";
            element.title = annotation.url;
            element.classList.add("external");
          } else {
            element.title = "Follow reference";
            element.addEventListener("click", function (event) {
              event.preventDefault();
              event.stopPropagation();
              self.goToDestination(annotation.dest);
            });
          }
          /* A link click already acted; do not also fire inverse SyncTeX. */
          element.addEventListener("dblclick", function (event) { event.stopPropagation(); });
          layer.appendChild(element);
        });

        pv.div.appendChild(layer);
        pv.linkLayer = layer;
      })
      .catch(function () {
        /* Links are a convenience; never let them break page rendering. */
      });
  };

  /** Follow a PDF destination (named or explicit) inside the stream. */
  ContinuousPdfViewer.prototype.goToDestination = function (dest) {
    var self = this;
    if (!this.pdfDoc || !dest) return Promise.resolve(false);
    var resolved = typeof dest === "string"
      ? this.pdfDoc.getDestination(dest)
      : Promise.resolve(dest);

    return resolved.then(function (explicit) {
      if (!explicit || !explicit.length) return false;
      var ref = explicit[0];
      var pageIndexPromise;
      if (ref && typeof ref === "object" && ref.num !== undefined) {
        pageIndexPromise = self.pdfDoc.getPageIndex(ref);
      } else if (typeof ref === "number") {
        pageIndexPromise = Promise.resolve(ref);
      } else {
        return false;
      }
      return pageIndexPromise.then(function (pageIndex) {
        var base = self.baseViewports[pageIndex];
        var mode = explicit[1] && explicit[1].name;
        var offsetY = 0;
        if (base && (mode === "XYZ" || mode === "FitH" || mode === "FitBH")) {
          var userY = mode === "XYZ" ? explicit[3] : explicit[2];
          if (typeof userY === "number") {
            /* PDF user space measures from the bottom of the page. */
            offsetY = Math.max(0, (base.height - userY) * self.scale - 70);
          }
        }
        self.pushHistory();
        self.scrollToPage(pageIndex + 1, { offsetY: offsetY, smooth: true });
        return true;
      });
    }).catch(function () { return false; });
  };

  ContinuousPdfViewer.prototype.pushHistory = function () {
    this.history.push(this.container.scrollTop);
    if (this.history.length > 60) this.history.shift();
    this.onHistoryChange(this.history.length);
  };

  ContinuousPdfViewer.prototype.back = function () {
    if (!this.history.length) return false;
    var target = this.history.pop();
    this.container.scrollTo({ top: target, behavior: scrollBehavior(true) });
    this.onHistoryChange(this.history.length);
    this._updateCurrentPage(true);
    return true;
  };

  ContinuousPdfViewer.prototype._release = function (pv) {
    pv.generation = (pv.generation || 0) + 1;
    if (pv.textTask && pv.textTask.cancel) pv.textTask.cancel();
    pv.textTask = null;
    if (pv.renderTask) {
      try {
        pv.renderTask.cancel();
      } catch (e) {
        /* ignore */
      }
      pv.renderTask = null;
    }
    if (pv.canvas) {
      pv.canvas.width = 0;
      pv.canvas.height = 0;
      if (pv.canvas.parentNode) pv.canvas.parentNode.removeChild(pv.canvas);
      pv.canvas = null;
    }
    if (pv.textLayer) {
      if (pv.textLayer.parentNode) pv.textLayer.parentNode.removeChild(pv.textLayer);
      pv.textLayer = null;
    }
    if (pv.linkLayer) {
      if (pv.linkLayer.parentNode) pv.linkLayer.parentNode.removeChild(pv.linkLayer);
      pv.linkLayer = null;
    }
    pv.renderedScale = 0;
    // A cancelled task still owns its queue slot until its promise settles.
    pv.div.classList.remove("is-rendered");
  };

  /* Release pages far outside the viewport so long documents stay light. */
  ContinuousPdfViewer.prototype._sweep = function () {
    var self = this;
    var top = this.container.scrollTop - RELEASE_MARGIN;
    var bottom = this.container.scrollTop + this.container.clientHeight + RELEASE_MARGIN;
    this.pageViews.forEach(function (pv) {
      if (!pv.canvas && !pv.rendering) return;
      var pageTop = pv.div.offsetTop;
      var pageBottom = pageTop + pv.div.offsetHeight;
      if (pageBottom < top || pageTop > bottom) self._release(pv);
    });
  };

  /* ------------------------------------------------------- page tracking */

  ContinuousPdfViewer.prototype._updateCurrentPage = function (force) {
    if (!this.pageViews.length) return;
    var probe = this.container.scrollTop + this.container.clientHeight * 0.35;
    var found = this.pageViews[0].num;
    for (var i = 0; i < this.pageViews.length; i += 1) {
      var pv = this.pageViews[i];
      var pageTop = pv.div.offsetTop;
      if (pageTop <= probe) found = pv.num;
      else break;
    }
    this._sweep();
    this._requestVisible();
    if (force || found !== this.currentPage) {
      this.currentPage = found;
      this.onPageChange(found, this.pageViews.length);
    }
  };

  /** The page whose box is closest to a viewport Y coordinate. */
  ContinuousPdfViewer.prototype._pageAtClientY = function (clientY) {
    var best = null;
    var bestDistance = Infinity;
    for (var i = 0; i < this.pageViews.length; i += 1) {
      var rect = this.pageViews[i].div.getBoundingClientRect();
      if (rect.bottom < -400 || rect.top > window.innerHeight + 400) continue;
      var distance = clientY < rect.top ? rect.top - clientY
        : (clientY > rect.bottom ? clientY - rect.bottom : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = this.pageViews[i];
        if (distance === 0) break;
      }
    }
    return best;
  };

  ContinuousPdfViewer.prototype._capturePosition = function () {
    if (!this.pageViews.length) return null;
    var top = this.container.scrollTop;
    for (var i = this.pageViews.length - 1; i >= 0; i -= 1) {
      var pv = this.pageViews[i];
      if (pv.div.offsetTop <= top || i === 0) {
        var height = pv.div.offsetHeight || 1;
        return { page: pv.num, fraction: (top - pv.div.offsetTop) / height };
      }
    }
    return null;
  };

  ContinuousPdfViewer.prototype._restorePosition = function (position) {
    var pv = this.pageViews[Math.min(position.page, this.pageViews.length) - 1];
    if (!pv) return;
    this.container.scrollTop = pv.div.offsetTop + position.fraction * pv.div.offsetHeight;
  };

  /* Smooth scrolling never advances in a hidden tab, so only ask for it when
     the document is actually visible; correctness must not depend on it. */
  function scrollBehavior(smooth) {
    return smooth && document.visibilityState === "visible" ? "smooth" : "auto";
  }

  ContinuousPdfViewer.prototype.scrollToPage = function (pageNumber, opts) {
    opts = opts || {};
    var pv = this.pageViews[clamp(pageNumber, 1, this.pageViews.length) - 1];
    if (!pv) return;
    var target = pv.div.offsetTop - 12 + (opts.offsetY || 0);
    this.container.scrollTo({ top: Math.max(0, target), behavior: scrollBehavior(opts.smooth) });
    this._updateCurrentPage(true);
  };

  ContinuousPdfViewer.prototype.getPageCount = function () {
    return this.pageViews.length;
  };

  /* ---------------------------------------------------- SyncTeX highlight */

  ContinuousPdfViewer.prototype._positionHighlight = function (pv) {
    var self = this;
    (pv.highlights || []).forEach(function (item) {
      var r = item.rect;
      item.el.style.left = r.x * self.scale + "px";
      item.el.style.top = r.y * self.scale + "px";
      item.el.style.width = Math.max(4, r.width * self.scale) + "px";
      item.el.style.height = Math.max(6, r.height * self.scale) + "px";
    });
  };

  ContinuousPdfViewer.prototype.clearHighlights = function () {
    clearTimeout(this._fadeTimer);
    this.pageViews.forEach(function (pv) {
      (pv.highlights || []).forEach(function (item) {
        if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
      });
      pv.highlights = [];
      pv.highlight = null;
    });
  };

  ContinuousPdfViewer.prototype._addHighlight = function (pv, rect, className) {
    var el = document.createElement("div");
    el.className = className;
    pv.div.appendChild(el);
    pv.highlights = pv.highlights || [];
    pv.highlights.push({ el: el, rect: rect });
    pv.highlight = el;
    this._positionHighlight(pv);
    return el;
  };

  /**
   * Highlight forward-SyncTeX line boxes. Rects are PDF points with a top-left
   * origin: {x, y (top), width, height}.
   */
  ContinuousPdfViewer.prototype.highlightRects = function (pageNumber, rects, opts) {
    opts = opts || {};
    this.clearHighlights();
    var pv = this.pageViews[clamp(pageNumber, 1, this.pageViews.length) - 1];
    if (!pv || !rects || !rects.length) return null;
    var self = this;
    var padY = 1.5;
    var first = null;
    rects.forEach(function (r) {
      var rect = { x: Math.max(0, r.x - 2), y: Math.max(0, r.y - padY), width: r.width + 4, height: r.height + 2 * padY };
      var el = self._addHighlight(pv, rect, "pdf-sync-highlight pulse");
      if (!first) first = rect;
      void el.offsetWidth;
    });
    if (opts.scroll !== false && first) {
      /* Record where the reader was before the jump, so Back returns there. */
      this.pushHistory();
      var offsetY = Math.max(0, first.y * this.scale - this.container.clientHeight * 0.3);
      this.scrollToPage(pageNumber, { offsetY: offsetY, smooth: true });
    }
    this._scheduleFade(opts.fadeAfter || 3500);
    return first;
  };

  /** Legacy single-box form: y is the baseline of the matched box. */
  ContinuousPdfViewer.prototype.highlight = function (pageNumber, x, y, width, height, opts) {
    return this.highlightRects(pageNumber, [{ x: x, y: y - height, width: width, height: height }], opts);
  };

  ContinuousPdfViewer.prototype._scheduleFade = function (delay) {
    var self = this;
    clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(function () {
      self.pageViews.forEach(function (pv) {
        (pv.highlights || []).forEach(function (item) { item.el.classList.add("fade"); });
      });
    }, delay);
  };

  /**
   * Mark one word inside the highlighted lines, using the text layer: SyncTeX
   * knows lines, the rendered text knows words. ``target`` carries the word
   * and a few source words before and after it for disambiguation.
   */
  ContinuousPdfViewer.prototype.markWord = function (pageNumber, target, rects) {
    var self = this;
    var pv = this.pageViews[clamp(pageNumber, 1, this.pageViews.length) - 1];
    if (!pv || !target || !target.word) return Promise.resolve(false);
    var token = this.loadToken;
    var started = Date.now();
    return new Promise(function (resolve) {
      (function attempt() {
        if (token !== self.loadToken) return resolve(false);
        var layer = pv.textLayer;
        var spans = layer ? layer.querySelectorAll("span") : [];
        if (!spans.length) {
          if (Date.now() - started > 3000) return resolve(false);
          return setTimeout(attempt, 60);
        }
        resolve(self._markWordInLayer(pv, spans, target, rects));
      })();
    });
  };

  function foldWord(text) {
    try { return text.normalize("NFKC").toLowerCase(); } catch (err) { return text.toLowerCase(); }
  }

  ContinuousPdfViewer.prototype._markWordInLayer = function (pv, spans, target, rects) {
    var pageBox = pv.div.getBoundingClientRect();
    var scale = this.scale;
    var areas = (rects || []).map(function (r) {
      return { left: r.x * scale - 6, right: (r.x + r.width) * scale + 6, top: r.y * scale - 4, bottom: (r.y + r.height) * scale + 4 };
    });
    var wordPattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
    var tokens = [];
    Array.prototype.forEach.call(spans, function (span) {
      var node = span.firstChild;
      if (!node || node.nodeType !== 3) return;
      var box = span.getBoundingClientRect();
      var local = { left: box.left - pageBox.left, right: box.right - pageBox.left, top: box.top - pageBox.top, bottom: box.bottom - pageBox.top };
      var inside = !areas.length || areas.some(function (a) {
        return local.right > a.left && local.left < a.right && local.bottom > a.top && local.top < a.bottom;
      });
      var text = node.nodeValue || "";
      var match;
      wordPattern.lastIndex = 0;
      while ((match = wordPattern.exec(text)) !== null) {
        tokens.push({ value: foldWord(match[0]), node: node, start: match.index, end: match.index + match[0].length, inside: inside });
      }
    });
    var needle = foldWord(target.word);
    var before = (target.before || []).map(foldWord);
    var after = (target.after || []).map(foldWord);
    var best = null;
    tokens.forEach(function (token, index) {
      if (token.value !== needle && token.value.indexOf(needle) !== 0) return;
      var score = token.value === needle ? 2 : 0;
      if (token.inside) score += 3;
      for (var b = 0; b < before.length; b += 1) {
        var prev = tokens[index - before.length + b];
        if (prev && prev.value === before[b]) score += 2;
      }
      for (var a = 0; a < after.length; a += 1) {
        var next = tokens[index + 1 + a];
        if (next && next.value === after[a]) score += 2;
      }
      if (!best || score > best.score) best = { score: score, token: token };
    });
    if (!best || best.score < 4) return false;
    var range = document.createRange();
    try {
      range.setStart(best.token.node, best.token.start);
      range.setEnd(best.token.node, best.token.end);
    } catch (err) {
      return false;
    }
    var hit = range.getBoundingClientRect();
    if (!hit.width) return false;
    var rect = {
      x: (hit.left - pageBox.left) / scale - 1.5,
      y: (hit.top - pageBox.top) / scale - 1,
      width: hit.width / scale + 3,
      height: hit.height / scale + 2,
    };
    this._addHighlight(pv, rect, "pdf-sync-word");
    return true;
  };

  ContinuousPdfViewer.prototype.destroy = function () {
    this.loadToken += 1;
    this._teardown();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  };

  global.ContinuousPdfViewer = ContinuousPdfViewer;
  global.PDF_CSS_UNITS = CSS_UNITS;
})(window);
