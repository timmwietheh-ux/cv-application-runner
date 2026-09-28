(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = {overview:null, profile:null, app:null, tab:null, info:null, data:null, version:null,
    dirty:false, busy:false, mode:"edit", selectedDocs:[], package:null};
  var hideToastTimer;

  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
  }); }
  function url(params) { return new URLSearchParams(params).toString(); }
  function label(value) { return String(value || "").replace(/-/g, " "); }
  function id(prefix) { return prefix + "-" + Math.random().toString(16).slice(2, 9); }
  function toast(message, error) {
    var box = $("toast"); clearTimeout(hideToastTimer); box.textContent = message;
    box.classList.toggle("error", !!error); box.hidden = false;
    hideToastTimer = setTimeout(function () { box.hidden = true; }, error ? 9000 : 4300);
  }
  async function request(path, options) {
    options = options || {};
    var method = options.method || "GET";
    var response = await fetch(path, {method:method, headers:method === "GET" ? {} : {"Content-Type":"application/json"},
      body:method === "GET" ? undefined : JSON.stringify(options.body || {}), credentials:"same-origin"});
    var result;
    try { result = await response.json(); } catch (_) { throw new Error("The Runner returned an unreadable response."); }
    if (!response.ok || !result.success) {
      if (response.status === 403 && method !== "GET" && !options.retried) {
        await fetch("/api/session", {credentials:"same-origin"});
        return request(path, Object.assign({}, options, {retried:true}));
      }
      throw new Error(result.error || ("Request failed (" + response.status + ")"));
    }
    return result;
  }
  function activeApp() { return (state.overview.applications || []).find(function (a) { return a.slug === state.app; }); }
  function docInfo(docId) { return ((activeApp() || {}).documents || []).find(function (d) { return d.id === docId; }); }
  function dirty(value) {
    state.dirty = value;
    $("save-state").textContent = value ? "Unsaved edits" : (state.busy ? "Working…" : "All saved");
    $("save-state").classList.toggle("dirty", value);
    $("save-doc").disabled = !value || state.busy;
  }
  function canLeave() { return !state.dirty || confirm("Discard the unsaved changes to this document?"); }
  function getPath(root, path) { return path.split(".").reduce(function (part, key) { return part == null ? undefined : part[key]; }, root); }
  function setPath(root, path, value) {
    var parts = path.split("."), parent = root;
    parts.slice(0, -1).forEach(function (key) { parent = parent[key]; });
    parent[parts[parts.length - 1]] = value;
  }
  function updateSourceSelection() {
    ["cv", "letter", "texts"].forEach(function (kind) {
      var select = $("new-" + kind); select.innerHTML = "";
      var options = [{value:"", text:kind === "cv" ? "No CV" : "None"}];
      (state.overview.templates || []).filter(function (t) { return t.kind === kind; }).forEach(function (t) {
        options.push({value:"template:" + t.id, text:"Template: " + t.title});
      });
      (state.overview.applications || []).forEach(function (app) {
        (app.documents || []).filter(function (doc) { return doc.kind === kind; }).forEach(function (doc) {
          options.push({value:app.slug + "/" + doc.id, text:"Copy: " + app.title + " / " + doc.label});
        });
      });
      options.forEach(function (entry) { var opt = document.createElement("option"); opt.value = entry.value; opt.textContent = entry.text; select.appendChild(opt); });
      if (kind === "cv") select.value = "template:academic-cv";
    });
  }
  function renderSidebar() {
    var query = $("app-search").value.toLowerCase().trim(), host = $("app-list"); host.innerHTML = "";
    (state.overview.categories || []).forEach(function (category) {
      var apps = (state.overview.applications || []).filter(function (app) {
        return app.category === category.id && (!query || (app.title + " " + app.organization + " " + app.summary).toLowerCase().includes(query));
      });
      if (!apps.length) return;
      var group = document.createElement("section"); group.className = "category";
      group.innerHTML = '<div class="category-heading"><span>' + esc(category.label) + '</span><b>' + apps.length + '</b></div>';
      apps.forEach(function (app) {
        var button = document.createElement("button"); button.type = "button";
        button.className = "app-item" + (state.app === app.slug ? " active" : "");
        button.innerHTML = "<strong>" + esc(app.title) + "</strong><span>" + esc(app.organization || label(app.status)) + "</span>";
        button.addEventListener("click", function () { selectApp(app.slug); }); group.appendChild(button);
      }); host.appendChild(group);
    });
    if (!host.childNodes.length) host.innerHTML = '<p class="helper" style="padding:10px">No matching applications.</p>';
  }
  function renderHeading() {
    var app = activeApp(); if (!app) { $("app-work").hidden = true; $("empty-work").hidden = false; return; }
    $("app-work").hidden = false; $("empty-work").hidden = true;
    var category = (state.overview.categories || []).find(function (item) { return item.id === app.category; });
    $("app-category").textContent = category ? category.label : app.category;
    $("app-title").textContent = app.title;
    $("app-summary").textContent = app.summary || app.organization || "";
    $("app-summary").hidden = state.mode === "print" || state.tab !== "overview";
    $("app-status").textContent = label(app.status);
    $("app-deadline").textContent = app.deadline ? "Deadline " + app.deadline : "";
    $("app-deadline").hidden = !app.deadline;
    var tabs = $("doc-tabs"); tabs.innerHTML = "";
    tabs.hidden = state.mode === "print";
    [{id:"overview",label:"Overview"}].concat(app.documents || []).forEach(function (doc) {
      var button = document.createElement("button"); button.type = "button"; button.textContent = doc.label;
      button.className = state.tab === doc.id ? "active" : ""; button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", state.tab === doc.id ? "true" : "false");
      button.addEventListener("click", function () { selectTab(doc.id); }); tabs.appendChild(button);
    });
  }
  async function refreshOverview() {
    state.overview = await request("/api/cv/overview");
    renderSidebar(); renderHeading(); updateSourceSelection();
  }
  async function selectApp(slug) {
    if (slug === state.app) return;
    if (!canLeave()) return;
    state.app = slug; state.tab = null; state.data = null; state.info = null;
    state.package = null; dirty(false);
    renderSidebar(); renderHeading();
    var app = activeApp();
    state.selectedDocs = (app.documents || []).filter(function (doc) { return doc.upload && doc.type !== "texts"; }).map(function (doc) { return doc.id; });
    if (!state.selectedDocs.length) state.selectedDocs = (app.documents || []).filter(function (doc) { return doc.type !== "texts"; }).slice(0, 1).map(function (doc) { return doc.id; });
    var preferred = (app.documents || []).find(function (d) { return d.id === "cv"; }) || (app.documents || [])[0];
    await selectTab(preferred ? preferred.id : "overview", true);
    if (state.mode === "print") renderPrint();
  }
  async function selectTab(tab, forced) {
    if (!forced && state.tab === tab) return;
    if (!forced && !canLeave()) return;
    state.tab = tab; state.data = null; state.info = null; state.version = null; dirty(false);
    renderHeading(); $("work-content").innerHTML = "";
    if (tab === "overview") { $("doc-toolbar").hidden = true; renderOverview(); renderPreview(); return; }
    var info = docInfo(tab); if (!info) return;
    state.info = info; $("doc-toolbar").hidden = false;
    $("doc-title").textContent = info.label;
    $("doc-subtitle").textContent = info.note || (info.type === "texts" ? "Copy-ready portal fields" : "Edit content, then build to refresh the PDF");
    $("build-doc").textContent = info.type === "texts" ? "Export texts" : "Build PDF";
    $("duplicate-doc").hidden = info.type === "tex";
    try {
      if (info.type === "block" || info.type === "texts") {
        var response = await request("/api/cv/document?" + url({app:state.app,doc:tab}));
        if (state.tab !== tab) return;
        state.data = response.doc; state.version = response.version;
        state.linkedBody = response.linkedBody;
        renderDocument();
      } else {
        $("work-content").innerHTML = '<div class="overview-card"><h3>LaTeX document</h3><p>This document uses an existing LaTeX source file. The block editor covers CVs, letters and portal text; open this file in the LaTeX view when you need to change its assembly.</p><a href="/code">Open LaTeX &amp; files</a></div>';
      }
      if (info.type !== "texts") await request("/api/cv/activate", {method:"POST",body:{app:state.app,doc:tab}});
      if (state.mode === "print") renderPrint();
      renderPreview();
    } catch (error) { toast(error.message, true); renderPreview(); }
  }
  function renderPreview() {
    var box = $("preview-body"), info = state.info;
    $("open-pdf").hidden = true;
    if (state.mode === "print") {
      $("preview-title").textContent = state.package ? "Selected PDF" : "PDF package";
      if (!state.package) {
        box.innerHTML = '<div class="preview-empty">Choose documents and prepare a PDF.</div>';
        $("preview-status").textContent = "The selected documents are rebuilt before export.";
        return;
      }
      var packageUrl = "/api/cv/package?" + url({app:state.app,name:state.package.name,t:Date.now()});
      box.innerHTML = "";
      var packageFrame = document.createElement("iframe"); packageFrame.title = "Selected PDF package";
      packageFrame.src = packageUrl; box.appendChild(packageFrame);
      $("open-pdf").href = packageUrl; $("open-pdf").hidden = false;
      $("preview-status").textContent = state.package.pages + " pages · " + Math.round(state.package.bytes / 1024) + " KB";
      return;
    }
    if (!info || info.type === "texts") {
      $("preview-title").textContent = info && info.type === "texts" ? "Portal text" : "PDF preview";
      $("preview-status").textContent = info && info.type === "texts" ? "Export the text sheet in Print & export." : "Last successful build";
      box.innerHTML = '<div class="preview-empty">' + (info && info.type === "texts" ? "Portal fields are edited here and exported as copy-ready Markdown." : "Select a PDF document to preview it here.") + '</div>';
      return;
    }
    $("preview-title").textContent = info.label;
    if (!info.built) { box.innerHTML = '<div class="preview-empty">No PDF yet. Select “Build PDF” to render this document.</div>'; $("preview-status").textContent = "No PDF built yet"; return; }
    var source = "/api/cv/pdf?" + url({app:state.app,doc:info.id,t:Date.now()});
    box.innerHTML = ""; var frame = document.createElement("iframe"); frame.title = info.label + " PDF"; frame.src = source; box.appendChild(frame);
    $("open-pdf").href = source; $("open-pdf").hidden = false;
    $("preview-status").textContent = "Last build · " + Math.round(info.built.bytes / 1024) + " KB";
  }
  function renderPrint() {
    var app = activeApp(); if (!app) return;
    $("doc-tabs").hidden = true; $("doc-toolbar").hidden = true;
    var docs = (app.documents || []).filter(function (doc) { return doc.type === "block" || doc.type === "tex"; });
    var instruction = "Build a single PDF in the order shown below. Check the target's upload requirements before submitting.";
    var html = '<div class="print-head"><div><span class="eyebrow">PDF output</span><h3>Choose your documents</h3></div><p>' + esc(instruction) + '</p></div><div class="print-list">';
    docs.forEach(function (doc) {
      var checked = state.selectedDocs.includes(doc.id), details = doc.exported || doc.built;
      html += '<div class="print-row' + (checked ? ' selected' : '') + '"><label><input type="checkbox" data-print-doc="' + esc(doc.id) + '"' + (checked ? ' checked' : '') + '><span class="print-row-main"><strong>' + esc(doc.label) + '</strong><small>' + (doc.upload ? 'Portal upload' : 'Additional PDF') + (details ? ' · ' + Math.round(details.bytes / 1024) + ' KB' : ' · Build required') + '</small></span><span class="print-row-check">' + (checked ? '✓' : '') + '</span></label>' + (details ? '<a class="print-download" href="/api/cv/download?' + url({app:state.app,doc:doc.id}) + '" title="Download last built PDF">Download</a>' : '') + '</div>';
    });
    html += '</div><div class="print-actions"><button id="prepare-package" class="button primary"' + (!state.selectedDocs.length || state.busy ? ' disabled' : '') + '>Prepare selected PDF</button><span>' + state.selectedDocs.length + ' selected</span></div>';
    if (state.package) {
      html += '<div class="package-ready"><span class="eyebrow">Ready to download</span><strong>' + esc(state.package.documents.map(function (doc) { return doc.label; }).join(' + ')) + '</strong><span>' + state.package.pages + ' pages · ' + Math.round(state.package.bytes / 1024) + ' KB</span><a class="button primary" href="/api/cv/package?' + url({app:state.app,name:state.package.name,download:"1"}) + '">Download PDF</a></div>';
    }
    var textDoc = (app.documents || []).find(function (doc) { return doc.type === "texts"; });
    if (textDoc) html += '<div class="print-text"><div><strong>Portal text sheet</strong><span>All written answers and form details in one file.</span></div><button class="button subtle" data-action="export-portal" data-doc="' + esc(textDoc.id) + '">Prepare text sheet</button>' + (textDoc.exported ? '<a class="button" href="/api/cv/text?' + url({app:state.app,doc:textDoc.id}) + '">Download text</a>' : '') + '</div>';
    $("work-content").innerHTML = html;
    $("work-content").classList.add("print-content");
  }
  async function buildPackage() {
    if (state.busy || !state.selectedDocs.length) return;
    state.busy = true; renderPrint();
    $("save-state").textContent = "Building PDF…";
    try {
      var result = await request("/api/cv/package", {method:"POST",body:{app:state.app,docs:state.selectedDocs}});
      await refreshOverview();
      state.package = result.package; renderPrint(); renderPreview();
      toast("PDF ready for download.");
    } catch (error) { toast(error.message, true); }
    finally { state.busy = false; renderPrint(); dirty(false); }
  }
  async function exportPortal(doc) {
    if (state.busy) return;
    state.busy = true; renderPrint();
    try {
      await request("/api/cv/build", {method:"POST",body:{app:state.app,doc:doc}});
      await refreshOverview(); renderPrint(); toast("Portal text sheet ready.");
    } catch (error) { toast(error.message, true); }
    finally { state.busy = false; renderPrint(); }
  }
  function setMode(mode) {
    if (state.mode === mode || !canLeave()) return;
    state.mode = mode;
    ["edit", "print"].forEach(function (key) {
      $("mode-" + key).classList.toggle("active", key === mode);
      $("mode-" + key).setAttribute("aria-pressed", key === mode ? "true" : "false");
    });
    $("work-content").classList.toggle("print-content", mode === "print");
    renderHeading();
    if (mode === "print") { renderPrint(); renderPreview(); }
    else selectTab(state.tab || "overview", true);
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("cv-theme", theme); } catch (_) { /* Private browser storage may be disabled. */ }
    $("theme-toggle").textContent = theme === "dark" ? "☀" : "☾";
    $("theme-toggle").title = theme === "dark" ? "Use light mode" : "Use dark mode";
    $("theme-toggle").setAttribute("aria-label", $("theme-toggle").title);
  }
  function formField(path, title, value, type, hint) {
    type = type || "text"; var wide = type === "textarea" || type === "code";
    var input = wide ? '<textarea data-path="' + esc(path) + '">' + esc(value) + '</textarea>' :
      '<input data-path="' + esc(path) + '" type="' + (type === "number" ? "number" : "text") + '" value="' + esc(value) + '">';
    return '<label class="field' + (wide ? " wide" : "") + (type === "code" ? " code" : "") + '"><span>' + esc(title) + '</span>' + input + (hint ? '<span class="hint">' + esc(hint) + '</span>' : "") + '</label>';
  }
  function actions(path, canMove, canDelete) {
    return '<div class="mini-actions">' + (canMove ? '<button data-action="move-up" data-path="' + esc(path) + '" title="Move up">↑</button><button data-action="move-down" data-path="' + esc(path) + '" title="Move down">↓</button>' : "") +
      (canDelete ? '<button class="delete" data-action="remove" data-path="' + esc(path) + '" title="Remove">×</button>' : "") + '</div>';
  }
  function nestedList(path, values, title) {
    var html = '<div class="nested-list"><div class="block-top"><strong>' + esc(title) + '</strong><span class="helper">One concise point per row</span></div>';
    (values || []).forEach(function (value, index) {
      var itemPath = path + "." + index;
      html += '<div class="nested-item">' + formField(itemPath, title + " " + (index + 1), value, "textarea") + actions(itemPath, true, true) + '</div>';
    });
    return html + '<button class="button small" data-action="add-string" data-path="' + esc(path) + '">+ Add point</button></div>';
  }
  function renderBlock(block, sectionIndex, blockIndex) {
    var path = "sections." + sectionIndex + ".blocks." + blockIndex;
    var schema = (state.overview.schema.blockTypes || {})[block.type] || {};
    var html = '<article class="block-card"><div class="block-top"><div><span class="block-tag">' + esc(schema.label || block.type) + '</span></div>' + actions(path, true, true) + '</div>';
    if (schema.hint) html += '<p class="helper">' + esc(schema.hint) + '</p>';
    html += '<div class="field-grid">';
    (schema.fields || []).forEach(function (field) {
      var itemPath = path + "." + field.key, value = block[field.key];
      if (field.type === "list") { html += nestedList(itemPath, value, field.label); return; }
      if (field.type === "rows") {
        html += '<div class="wide nested-list"><div class="block-top"><strong>Rows</strong></div>';
        (value || []).forEach(function (row, index) {
          var rowPath = itemPath + "." + index;
          html += '<div class="nested-item" style="display:block"><div class="field-grid">' + formField(rowPath + ".label", "Label", row.label) + formField(rowPath + ".text", "Text", row.text, "textarea") + '</div>' + actions(rowPath, true, true) + '</div>';
        });
        html += '<button class="button small" data-action="add-row" data-path="' + esc(itemPath) + '">+ Add row</button></div>'; return;
      }
      if (field.type === "cards") {
        html += '<div class="wide nested-list"><div class="block-top"><strong>Cards</strong></div>';
        (value || []).forEach(function (card, index) {
          var cardPath = itemPath + "." + index;
          html += '<div class="nested-list">' + formField(cardPath + ".title", "Card title", card.title) + nestedList(cardPath + ".items", card.items, "Point") + actions(cardPath, true, true) + '</div>';
        });
        html += '<button class="button small" data-action="add-card" data-path="' + esc(itemPath) + '">+ Add card</button></div>'; return;
      }
      html += formField(itemPath, field.label, value, field.type === "longtext" ? "textarea" : field.type === "code" ? "code" : "text", field.type === "facts" ? "Separate facts with |" : "");
    });
    html += '</div><label class="contact-list"><input type="checkbox" data-path="' + esc(path + ".hidden") + '"' + (block.hidden ? " checked" : "") + '> Hide this block in the PDF</label></article>';
    return html;
  }
  function renderHeader() {
    var doc = state.data, head = doc.header || {}, html = '<details class="overview-card compact-details"><summary>Header and contact lines</summary><div class="field-grid">';
    html += formField("title", "Document title", doc.title);
    html += formField("header.name", "Name override", head.name, "text", "Empty uses the shared profile name.");
    html += formField("header.headline", "Headline", head.headline);
    html += formField("header.tagline", "Tagline", head.tagline);
    html += '</div><div class="field"><span>Contact lines</span><div class="contact-list">';
    Object.keys((state.profile || {}).contacts || {}).forEach(function (key) {
      html += '<label><input type="checkbox" data-contact="' + esc(key) + '"' + ((head.contacts || []).includes(key) ? " checked" : "") + '>' + esc(key) + '</label>';
    });
    return html + '</div></div></details>';
  }
  function renderCv() {
    var doc = state.data, html = renderHeader() + '<h3 class="doc-section-title">Sections &amp; blocks</h3>';
    (doc.sections || []).forEach(function (section, sectionIndex) {
      var sectionPath = "sections." + sectionIndex;
      html += '<section class="section-card"><div class="section-top">' + formField(sectionPath + ".title", "Section", section.title) + actions(sectionPath, true, true) + '</div>';
      html += '<label class="contact-list"><input type="checkbox" data-path="' + sectionPath + '.hidden"' + (section.hidden ? " checked" : "") + '> Hide section</label>';
      (section.blocks || []).forEach(function (block, blockIndex) { html += renderBlock(block, sectionIndex, blockIndex); });
      html += '<div class="add-block"><select data-block-picker="' + sectionIndex + '">';
      Object.keys(state.overview.schema.blockTypes || {}).forEach(function (type) {
        html += '<option value="' + esc(type) + '">' + esc(state.overview.schema.blockTypes[type].label) + '</option>';
      });
      html += '</select><button class="button small" data-action="add-block" data-section="' + sectionIndex + '">+ Add block</button></div></section>';
    });
    return html + '<button class="button" data-action="add-section">+ Add section</button><div class="overview-card" style="margin-top:18px">' + formField("footer", "Footer label", doc.footer) + '</div>';
  }
  function renderLetter() {
    var doc = state.data, html = renderHeader() + '<h3 class="doc-section-title">Letter details</h3><div class="overview-card"><div class="field-grid">';
    (state.overview.schema.letter || []).forEach(function (field) {
      html += formField(field.key, field.label, doc[field.key], field.type === "longtext" ? "textarea" : "text", field.key === "bodyFrom" ? "Link a portal field, e.g. portal.json#motivation. Empty: edit the paragraphs below." : "");
    }); html += '</div></div>';
    if (doc.bodyFrom) {
      html += '<div class="overview-card"><h3>Letter text</h3><p>Linked to <strong>' + esc(doc.bodyFrom) + '</strong>.</p>';
      html += '<button class="button small" data-action="open-portal">Edit portal text</button>';
      if (state.linkedBody) html += '<details class="compact-details"><summary>Read letter body</summary><pre class="note-view">' + esc(state.linkedBody) + '</pre></details>';
      html += '</div>';
    } else {
      html += '<h3 class="doc-section-title">Paragraphs</h3>';
      (doc.body || []).forEach(function (block, index) {
        var path = "body." + index;
        html += '<article class="block-card"><div class="block-top"><strong>Paragraph ' + (index + 1) + '</strong>' + actions(path, true, true) + '</div>' + formField(path + ".text", "Text", block.text, "textarea") + '</article>';
      });
      html += '<button class="button" data-action="add-paragraph">+ Add paragraph</button>';
    }
    return html;
  }
  function renderTexts() {
    var doc = state.data, html = '<div class="portal-intro"><h3>Portal answers</h3><p>Copy each answer into the matching field of the real application form.</p></div><details class="overview-card compact-details"><summary>Text sheet settings</summary><div class="field-grid">' + formField("title", "Document title", doc.title) + formField("portal", "Portal URL", doc.portal) + formField("intro", "Instructions", doc.intro, "textarea") + '</div></details>';
    (doc.fields || []).forEach(function (field, index) {
      var path = "fields." + index, count = (field.text || "").length, over = field.limit && count > field.limit;
        html += '<article class="portal-card"><div class="portal-top"><strong>' + esc(field.title) + (field.required ? " *" : "") + '</strong><span class="count' + (over ? " over" : "") + '" data-count="' + index + '">' + count + (field.limit ? " / " + field.limit : " characters") + '</span>' + actions(path, true, true) + '</div>';
      html += '<p class="prompt">' + esc(field.prompt) + '</p>' + formField(path + ".text", "Answer", field.text, "textarea");
      html += '<footer><button class="button small" data-action="copy-field" data-index="' + index + '">Copy answer</button><details class="compact-details"><summary>Field settings</summary><div class="field-grid">' + formField(path + ".title", "Field title", field.title) + formField(path + ".limit", "Character limit", field.limit == null ? "" : field.limit, "number") + '</div>';
      html += formField(path + ".prompt", "Exact prompt", field.prompt, "textarea") + formField(path + ".notes", "Internal notes", field.notes, "textarea");
      html += '<label class="field" style="margin:0">Status <select data-path="' + path + '.status">';
      ["draft", "review", "final"].forEach(function (status) { html += '<option' + (field.status === status ? " selected" : "") + '>' + status + '</option>'; });
      html += '</select></label></details></footer></article>';
    });
    return html + '<button class="button" data-action="add-field">+ Add portal field</button>';
  }
  function renderDocument() {
    if (!state.data) return;
    $("work-content").innerHTML = state.data.kind === "cv" ? renderCv() : state.data.kind === "letter" ? renderLetter() : renderTexts();
    dirty(state.dirty);
  }
  function renderOverview() {
    var app = activeApp(), cats = state.overview.categories || [];
    var pending = (app.checklist || []).filter(function (item) { return !item.done; }).length;
    var html = '<div class="overview-card"><h3>Next steps <span class="overview-count">' + pending + ' open</span></h3><div id="checklist">';
    (app.checklist || []).forEach(function (item, index) {
      html += '<label class="list-check' + (item.done ? " done" : "") + '"><input type="checkbox" data-check="' + index + '"' + (item.done ? " checked" : "") + '><span>' + esc(item.text) + '</span></label>';
    });
    html += '</div><div class="add-block"><input id="new-check-text" placeholder="Add a step" style="flex:1;border:1px solid var(--line);border-radius:7px;padding:6px 9px"><button class="button small" data-action="add-check">Add</button></div></div>';
    html += '<details class="overview-card compact-details"><summary>Application settings</summary><div class="field-grid">';
    html += formField("app.title", "Application title", app.title) + formField("app.organization", "Organization", app.organization);
    html += '<label class="field"><span>Category</span><select id="overview-category">';
    cats.forEach(function (cat) { html += '<option value="' + esc(cat.id) + '"' + (cat.id === app.category ? " selected" : "") + '>' + esc(cat.label) + '</option>'; });
    html += '</select></label><label class="field"><span>Status</span><select id="overview-status">';
    (state.overview.schema.statuses || []).forEach(function (status) { html += '<option' + (status === app.status ? " selected" : "") + '>' + esc(status) + '</option>'; });
    html += '</select></label><label class="field"><span>Deadline</span><input id="overview-deadline" type="date" value="' + esc(app.deadline) + '"></label>';
    html += formField("app.summary", "Summary", app.summary, "textarea") + '</div><button class="button primary" data-action="save-app">Save settings</button></details>';
    if ((app.notes || []).length) {
      html += '<details class="overview-card compact-details"><summary>Dossier and source material</summary>';
      app.notes.forEach(function (note) { if (note.exists) html += '<button class="note-link" data-action="open-note" data-path="' + esc(note.path) + '">' + esc(note.label) + ' ↗</button>'; });
      html += '<div id="note-content"></div></details>';
    }
    if ((app.links || []).length) {
      html += '<details class="overview-card compact-details"><summary>Official links</summary>';
      app.links.forEach(function (link) { if (/^https?:\/\//i.test(link.url || "")) html += '<a class="note-link" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">' + esc(link.label || link.url) + ' ↗</a>'; });
      html += '</details>';
    }
    $("work-content").innerHTML = html;
  }
  function changeArray(path, action) {
    var parts = path.split("."), index = Number(parts.pop()), parent = getPath(state.data, parts.join("."));
    if (!Array.isArray(parent) || !Number.isInteger(index)) return;
    if (action === "remove") { if (!confirm("Remove this item?")) return; parent.splice(index, 1); }
    else {
      var target = index + (action === "move-up" ? -1 : 1);
      if (target < 0 || target >= parent.length) return;
      var item = parent.splice(index, 1)[0]; parent.splice(target, 0, item);
    }
    dirty(true); renderDocument();
  }
  async function saveDocument() {
    if (!state.data || !state.dirty) return true;
    try {
      var result = await request("/api/cv/save", {method:"POST",body:{app:state.app,doc:state.tab,data:state.data,version:state.version}});
      state.version = result.version; dirty(false);
      if (result.problems && result.problems.length) toast(result.problems.join("\n"), true);
      else toast("Saved to " + (state.info && state.info.source || "the application"));
      return true;
    } catch (error) { toast(error.message, true); return false; }
  }
  async function buildDocument() {
    if (!state.info || state.busy) return;
    if (!await saveDocument()) return;
    state.busy = true; $("build-doc").disabled = true; $("build-doc").textContent = "Building…";
    $("save-state").textContent = "Building document…";
    try {
      var result = await request("/api/cv/build", {method:"POST",body:{app:state.app,doc:state.tab}});
      await refreshOverview(); state.info = docInfo(state.tab);
      renderPreview(); toast(result.pdf ? "PDF built and exported successfully." : "Portal texts exported successfully.");
      $("preview-status").textContent = result.export.output + " · " + Math.round(result.export.bytes / 1024) + " KB";
    } catch (error) { toast(error.message, true); }
    finally { state.busy = false; $("build-doc").disabled = false; $("build-doc").textContent = state.info && state.info.type === "texts" ? "Export texts" : "Build PDF"; dirty(state.dirty); }
  }
  async function updateApplication(changes) {
    var result = await request("/api/cv/application", {method:"POST",body:{app:state.app,changes:changes}});
    await refreshOverview(); return result;
  }
  function onInput(event) {
    var target = event.target, path = target.dataset.path;
    if (path && state.data) {
      var value = target.type === "checkbox" ? target.checked : target.type === "number" ? (target.value === "" ? null : Number(target.value)) : target.value;
      setPath(state.data, path, value); dirty(true);
      if (path.indexOf("fields.") === 0 && path.endsWith(".text")) {
        var index = Number(path.split(".")[1]), field = state.data.fields[index], count = $("work-content").querySelector('[data-count="' + index + '"]');
        if (count) { var n = field.text.length; count.textContent = n + (field.limit ? " / " + field.limit : " characters"); count.classList.toggle("over", !!field.limit && n > field.limit); }
      }
      return;
    }
    if (target.dataset.contact && state.data) {
      var contacts = state.data.header.contacts || [], key = target.dataset.contact;
      if (target.checked && !contacts.includes(key)) contacts.push(key);
      if (!target.checked) state.data.header.contacts = contacts.filter(function (item) { return item !== key; });
      dirty(true);
    }
  }
  async function onAction(event) {
    var button = event.target.closest("[data-action]"); if (!button) return;
    var action = button.dataset.action, path = button.dataset.path;
    try {
      if (["move-up", "move-down", "remove"].includes(action)) return changeArray(path, action);
      if (action === "add-section") state.data.sections.push({id:id("s"),title:"New section",blocks:[]});
      else if (action === "add-block") {
        var section = Number(button.dataset.section), type = $("work-content").querySelector('[data-block-picker="' + section + '"]').value;
        var block = {id:id("b"),type:type};
        ((state.overview.schema.blockTypes[type] || {}).fields || []).forEach(function (field) {
          block[field.key] = field.type === "list" || field.type === "rows" || field.type === "cards" ? [] : "";
        });
        state.data.sections[section].blocks.push(block);
      } else if (action === "add-string") getPath(state.data, path).push("");
      else if (action === "add-row") getPath(state.data, path).push({label:"",text:""});
      else if (action === "add-card") getPath(state.data, path).push({title:"",items:[]});
      else if (action === "add-paragraph") state.data.body.push({id:id("p"),type:"paragraph",text:""});
      else if (action === "add-field") state.data.fields.push({id:id("f"),title:"New field",prompt:"",limit:null,required:false,status:"draft",text:"",notes:""});
      else if (action === "copy-field") { await navigator.clipboard.writeText(state.data.fields[Number(button.dataset.index)].text); toast("Answer copied."); return; }
      else if (action === "export-portal") { await exportPortal(button.dataset.doc); return; }
      else if (action === "open-portal") { await selectTab("portal"); return; }
      else if (action === "open-note") {
        var result = await request("/api/files/read?" + url({path:path}));
        $("note-content").innerHTML = '<pre class="note-view">' + esc(result.content) + '</pre>'; return;
      } else if (action === "save-app") {
        await updateApplication({title:$("work-content").querySelector('[data-path="app.title"]').value,
          organization:$("work-content").querySelector('[data-path="app.organization"]').value,
          category:$("overview-category").value,status:$("overview-status").value,
          deadline:$("overview-deadline").value,summary:$("work-content").querySelector('[data-path="app.summary"]').value});
        renderOverview(); toast("Target details saved."); return;
      } else if (action === "add-check") {
        var input = $("new-check-text"), value = input.value.trim(); if (!value) return;
        await updateApplication({checklist:(activeApp().checklist || []).concat([{text:value,done:false}])});
        renderOverview(); toast("Checklist item added."); return;
      } else return;
      dirty(true); renderDocument();
    } catch (error) { toast(error.message, true); }
  }
  async function createApplication(event) {
    event.preventDefault();
    var form = $("new-app-form"), values = Object.fromEntries(new FormData(form).entries());
    if (!form.reportValidity()) return;
    try {
      var result = await request("/api/cv/create", {method:"POST",body:values});
      $("new-app-dialog").close(); form.reset(); await refreshOverview(); await selectApp(result.application.slug);
      toast("Application created. Update its target dossier and tailor the copied documents.");
    } catch (error) { toast(error.message, true); }
  }
  async function duplicateDocument() {
    if (!state.info || !canLeave()) return;
    var idValue = prompt("ID for the document copy (lower-case letters, digits and hyphens):", state.tab + "-variant");
    if (!idValue) return;
    var name = prompt("Name shown in this application:", state.info.label + " (variant)");
    try {
      await request("/api/cv/duplicate", {method:"POST",body:{app:state.app,doc:state.tab,id:idValue,label:name || ""}});
      await refreshOverview(); await selectTab(idValue, true); toast("Document copy created.");
    } catch (error) { toast(error.message, true); }
  }
  async function init() {
    try { setTheme(localStorage.getItem("cv-theme") || "dark"); } catch (_) { setTheme("dark"); }
    $("theme-toggle").addEventListener("click", function () { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
    $("mode-edit").addEventListener("click", function () { setMode("edit"); });
    $("mode-print").addEventListener("click", function () { setMode("print"); });
    $("app-search").addEventListener("input", renderSidebar);
    $("work-content").addEventListener("input", onInput);
    $("work-content").addEventListener("change", function (event) {
      onInput(event);
      var selected = event.target.dataset.printDoc;
      if (selected != null) {
        if (event.target.checked && !state.selectedDocs.includes(selected)) state.selectedDocs.push(selected);
        if (!event.target.checked) state.selectedDocs = state.selectedDocs.filter(function (item) { return item !== selected; });
        var order = (activeApp().documents || []).map(function (doc) { return doc.id; });
        state.selectedDocs.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
        state.package = null; renderPrint(); renderPreview();
        return;
      }
      var check = event.target.dataset.check;
      if (check != null) {
        var items = (activeApp().checklist || []).map(function (item) { return {text:item.text,done:item.done}; });
        items[Number(check)].done = event.target.checked;
        updateApplication({checklist:items}).then(function () { renderOverview(); }).catch(function (error) { toast(error.message, true); });
      }
    });
    $("work-content").addEventListener("click", function (event) {
      if (event.target.id === "prepare-package") return buildPackage();
      return onAction(event);
    });
    $("save-doc").addEventListener("click", saveDocument);
    $("build-doc").addEventListener("click", buildDocument);
    $("duplicate-doc").addEventListener("click", duplicateDocument);
    $("refresh-preview").addEventListener("click", renderPreview);
    $("new-app").addEventListener("click", function () { $("new-app-dialog").showModal(); });
    $("new-app-form").addEventListener("submit", createApplication);
    $("new-app-form").elements.title.addEventListener("input", function (event) {
      var slug = $("new-app-form").elements.slug; if (slug.dataset.touched) return;
      slug.value = event.target.value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
    });
    $("new-app-form").elements.slug.addEventListener("input", function (event) { event.target.dataset.touched = "1"; });
    window.addEventListener("beforeunload", function (event) { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveDocument(); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); state.mode === "print" ? buildPackage() : buildDocument(); }
    });
    try {
      state.overview = await request("/api/cv/overview");
      var profile = await request("/api/cv/profile"); state.profile = profile.profile;
      $("new-category").innerHTML = (state.overview.categories || []).map(function (cat) { return '<option value="' + esc(cat.id) + '">' + esc(cat.label) + '</option>'; }).join("");
      renderSidebar(); updateSourceSelection();
      var wanted = new URLSearchParams(location.search).get("app"), list = state.overview.applications || [];
      var first = list.find(function (app) { return app.slug === wanted; }) || list[0];
      if (first) await selectApp(first.slug);
    } catch (error) { toast(error.message, true); $("empty-work").querySelector("p").textContent = error.message; }
  }
  init();
})();
