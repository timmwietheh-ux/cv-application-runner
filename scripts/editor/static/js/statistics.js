/* Local, read-only document statistics. No AI call and no extra dependency. */
(function () {
  "use strict";
  var hooks, panel, content, status, refreshButton, data, repository = null;
  var view = "overview", sectionId = 0, metric = "words", paragraphPage = 0;
  var paragraphOrder = "longest", paragraphBin = -1;
  var repoMeasure = "bytes", sourceOnly = true, busy = false, pending = false, revision = 0;
  var expandedSections = new Set();
  var timer = 0;
  var colors = ["#5ac8fa", "#b392f0", "#35c98a", "#ffc451", "#ff6f91", "#3fd4e8", "#ff9f5a", "#8b9cff"];
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function number(value) { return Number(value || 0).toLocaleString(); }
  function bytes(value) {
    if (value < 1024) return number(value) + " B";
    if (value < 1048576) return (value / 1024).toFixed(1) + " KiB";
    return (value / 1048576).toFixed(1) + " MiB";
  }
  function button(label, action, className) {
    var node = el("button", className || "btn btn-secondary btn-sm", label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function select(label, values, value, change) {
    var wrap = el("label", "stats-select");
    wrap.appendChild(el("span", "", label));
    var node = el("select", "mini-select");
    node.setAttribute("aria-label", label);
    values.forEach(function (item) {
      var option = el("option", "", item[1]); option.value = item[0]; node.appendChild(option);
    });
    node.value = value;
    node.addEventListener("change", function () { change(node.value); });
    wrap.appendChild(node);
    return wrap;
  }
  function note(text) { return el("p", "stats-note", text); }
  function block(title, parent) {
    var node = el("section", "stats-block");
    node.appendChild(el("h3", "", title));
    (parent || content).appendChild(node);
    return node;
  }
  function source(item) {
    var node = button("Open source ↗", function () { hooks.openSource(item); }, "stats-source");
    node.title = item.file + ":" + item.line;
    return node;
  }
  function visible() { return panel.classList.contains("active"); }
  function currentSection() {
    return data.document.sections[sectionId] || data.document.sections[0];
  }
  function descendant(id) {
    while (id != null) {
      if (id === sectionId) return true;
      id = data.document.sections[id].parent;
    }
    return false;
  }
  function sectionName(section) {
    return (section.number ? section.number + " · " : "") + section.title;
  }
  function scopePicker() {
    content.appendChild(select("Section", data.document.sections.map(function (s) {
      return [s.id, (s.id ? "· ".repeat(Math.max(0, s.level - 2)) : "") + sectionName(s)];
    }), sectionId, function (value) {
      sectionId = Number(value); paragraphPage = 0; render();
    }));
  }
  function crumbs() {
    var ids = [], id = currentSection().id;
    while (id != null) { ids.unshift(id); id = data.document.sections[id].parent; }
    var nav = el("nav", "stats-crumbs"); nav.setAttribute("aria-label", "Section path");
    ids.forEach(function (key, index) {
      if (index) nav.appendChild(el("span", "", "›"));
      nav.appendChild(button(key ? sectionName(data.document.sections[key]) : "Document", function () {
        sectionId = key; render();
      }, "stats-crumb"));
    });
    content.appendChild(nav);
  }
  function cards(items, parent) {
    var grid = el("div", "stats-cards");
    items.forEach(function (item) {
      var card = el("div", "stats-card");
      card.appendChild(el("strong", "", item[2] ? String(item[1]) : number(item[1])));
      card.appendChild(el("span", "", item[0]));
      grid.appendChild(card);
    });
    (parent || content).appendChild(grid);
  }
  function bar(label, value, maximum, detail, action, color) {
    var row = action ? button("", action, "stats-bar-row") : el("div", "stats-bar-row");
    var head = el("div", "stats-bar-heading");
    head.appendChild(el("span", "", label));
    head.appendChild(el("strong", "", detail));
    row.appendChild(head);
    var track = el("div", "stats-bar-track");
    var fill = el("span", "");
    fill.style.width = (maximum ? Math.max(0, Math.min(100, 100 * value / maximum)) : 0) + "%";
    if (color) fill.style.background = color;
    track.appendChild(fill); row.appendChild(track);
    return row;
  }
  function metricName() {
    return ({ words: "words", equations: "equation blocks", paragraphs: "paragraphs",
      figures: "figures", tables: "tables" })[metric] || metric;
  }
  function compositionParts(section) {
    var parts = [];
    var direct = Number(section.own[metric] || 0);
    if (direct) parts.push({ label: "Direct section content", value: direct, section: null });
    section.children.forEach(function (id) {
      var child = data.document.sections[id];
      var value = Number(child.totals[metric] || 0);
      if (value) parts.push({ label: sectionName(child), value: value, section: child });
    });
    return parts;
  }
  function sectionAccordion(section, index) {
    var expanded = expandedSections.has(section.id);
    var card = el("article", "stats-section-accordion" + (expanded ? " open" : ""));
    var head = button("", function () {
      if (expandedSections.has(section.id)) expandedSections.delete(section.id);
      else expandedSections.add(section.id);
      render();
    }, "stats-section-head");
    var bodyId = "stats-section-detail-" + section.id;
    head.setAttribute("aria-expanded", String(expanded));
    head.setAttribute("aria-controls", bodyId);
    var headline = el("span", "stats-section-headline");
    headline.appendChild(el("span", "stats-section-number", section.number || "—"));
    headline.appendChild(el("span", "stats-section-title", section.title));
    headline.appendChild(el("span", "stats-section-total", number(section.totals[metric]) + " " + metricName()));
    var chevron = el("span", "stats-section-chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    headline.appendChild(chevron);
    head.appendChild(headline);
    var documentTotal = Number(data.document.sections[0].totals[metric] || 0);
    var sectionTotal = Number(section.totals[metric] || 0);
    var documentShare = documentTotal ? 100 * sectionTotal / documentTotal : 0;
    var share = el("span", "stats-section-share");
    var shareTrack = el("span", "stats-bar-track");
    var shareFill = el("span", "");
    shareFill.style.width = Math.max(0, Math.min(100, documentShare)) + "%";
    shareFill.style.background = colors[index % colors.length];
    shareTrack.appendChild(shareFill);
    share.appendChild(shareTrack);
    share.appendChild(el("small", "", documentShare.toFixed(1) + "% of document"));
    head.appendChild(share);
    head.setAttribute("aria-label", sectionName(section) + ", " + number(sectionTotal) + " " + metricName() +
      ", " + documentShare.toFixed(1) + " percent of document");
    card.appendChild(head);
    if (!expanded) return card;

    var body = el("div", "stats-section-detail");
    body.id = bodyId;
    var parts = compositionParts(section);
    var total = parts.reduce(function (sum, item) { return sum + item.value; }, 0);
    if (parts.length > 1 && total > 0) {
      var visual = el("div", "stats-donut-layout");
      var donut = el("div", "stats-donut");
      var cursor = 0, stops = [];
      parts.forEach(function (item, partIndex) {
        var start = cursor;
        cursor += 100 * item.value / total;
        stops.push(colors[(index + partIndex) % colors.length] + " " + start.toFixed(3) + "% " + cursor.toFixed(3) + "%");
      });
      donut.style.background = "conic-gradient(" + stops.join(",") + ")";
      donut.setAttribute("role", "img");
      donut.setAttribute("aria-label", sectionName(section) + " composition by " + metricName() + ": " +
        parts.map(function (item) { return item.label + " " + number(item.value); }).join(", "));
      donut.appendChild(el("span", "stats-donut-center", number(total)));
      visual.appendChild(donut);
      body.appendChild(visual);
    } else if (!parts.length) {
      body.appendChild(note("No " + metricName() + " are recorded for this section."));
    } else {
      body.appendChild(note("This section has one non-zero component, so a proportional bar is clearer than a donut."));
    }

    var legend = el("div", "stats-donut-legend");
    parts.forEach(function (item, partIndex) {
      var row = item.section ? button("", function () {
        sectionId = item.section.id; render();
      }, "stats-legend-row") : el("div", "stats-legend-row");
      var swatch = el("i", ""); swatch.style.background = colors[(index + partIndex) % colors.length];
      row.appendChild(swatch);
      row.appendChild(el("span", "", item.label));
      row.appendChild(el("strong", "", number(item.value) + (total ? " · " + (100 * item.value / total).toFixed(1) + "%" : "")));
      legend.appendChild(row);
    });
    body.appendChild(legend);
    if (!section.children.length) body.appendChild(note("No direct subsections. Only content owned by this section is shown."));
    var actions = el("div", "stats-actions");
    actions.appendChild(button("Open section statistics", function () { sectionId = section.id; render(); }));
    actions.appendChild(source(section));
    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }
  function overview() {
    crumbs();
    var section = currentSection(), t = section.totals;
    cards([["Words ≈", t.words], ["Equation blocks", t.equations], ["Paragraphs", t.paragraphs],
      ["Figures", t.figures], ["Tables", t.tables], [sectionId ? "Subheadings" : "Headings",
        sectionId ? data.document.sections.filter(function (s) { return s.id !== sectionId && descendant(s.id); }).length : data.document.totals.sections]]);
    content.appendChild(note(number(t.body_words) + " body · " + number(t.heading_words) +
      " heading · " + number(t.caption_words) + " caption words"));
    var chart = block(sectionId ? section.title : "Section lengths");
    chart.appendChild(select("Compare", [["words", "Words"], ["equations", "Equation blocks"],
      ["paragraphs", "Paragraphs"], ["figures", "Figures"], ["tables", "Tables"]], metric, function (value) {
      metric = value; render();
    }));
    var children = section.children.map(function (id) { return data.document.sections[id]; });
    var max = Math.max.apply(null, children.map(function (s) { return s.totals[metric]; }).concat([1]));
    children.forEach(function (s, i) {
      if (!sectionId) {
        chart.appendChild(sectionAccordion(s, i));
        return;
      }
      var wrapper = el("div", "stats-section-row");
      var value = s.totals[metric];
      wrapper.appendChild(bar(sectionName(s) + (s.children.length ? " ›" : ""), value, max,
        number(value) + " · " + (t[metric] ? (100 * value / t[metric]).toFixed(1) : "0") + "%",
        function () { sectionId = s.id; render(); }, colors[i % colors.length]));
      wrapper.appendChild(source(s));
      chart.appendChild(wrapper);
    });
    if (!children.length) chart.appendChild(note("No deeper headings. The Paragraphs view lists this section's prose."));
    chart.appendChild(note(sectionId
      ? "Bars share a scale within this level. Totals include descendants; content directly under the selected heading: " +
        number(section.own[metric]) + "."
      : "Each bar shows the section share of the whole document. Open a numbered section to see its direct subsection composition. Donuts and legends use only the selected metric returned by this statistics scan."));
    var actions = el("div", "stats-actions");
    actions.appendChild(button("Paragraphs of this section", function () { changeView("paragraphs"); }));
    if (sectionId) actions.appendChild(source(section));
    chart.appendChild(actions);
    methodology();
  }
  function methodology() {
    var details = el("details", "stats-method");
    details.appendChild(el("summary", "", "Counting rules & scope"));
    Object.keys(data.method).forEach(function (key) { details.appendChild(note(data.method[key])); });
    details.appendChild(note("Entry: " + (data.document.sections[0].file || "main file") + " · " +
      number(data.document.totals.files) +
      " included files. Only literal input/include paths are followed; custom TeX conditionals are not evaluated."));
    content.appendChild(details);
  }
  function paragraphs() {
    scopePicker();
    var all = data.document.paragraphs.filter(function (p) { return descendant(p.section); });
    var lengths = all.map(function (p) { return p.words; }).sort(function (a, b) { return a - b; });
    var median = lengths.length ? (lengths[Math.floor((lengths.length - 1) / 2)] + lengths[Math.floor(lengths.length / 2)]) / 2 : 0;
    cards([["Paragraphs", all.length], ["Average words", all.length ? Math.round(all.reduce(function (s, p) { return s + p.words; }, 0) / all.length) : 0],
      ["Median words", median], ["Longest", lengths[lengths.length - 1] || 0]]);
    var chart = block("Words per paragraph");
    var bins = data.document.paragraph_summary.histogram;
    var counts = bins.map(function (bin) {
      return all.filter(function (p) { return p.words >= bin.min && (bin.max == null || p.words <= bin.max); }).length;
    });
    bins.forEach(function (bin, i) {
      var row = bar(bin.label + " words", counts[i], Math.max.apply(null, counts.concat([1])),
        number(counts[i]), function () { paragraphBin = paragraphBin === i ? -1 : i; paragraphPage = 0; render(); });
      row.classList.toggle("selected", paragraphBin === i);
      row.setAttribute("aria-pressed", String(paragraphBin === i));
      chart.appendChild(row);
    });
    if (paragraphBin >= 0) chart.appendChild(button("Clear length filter", function () { paragraphBin = -1; paragraphPage = 0; render(); }));
    content.appendChild(select("Sort paragraphs", [["longest", "Longest first"], ["document", "Document order"]],
      paragraphOrder, function (value) { paragraphOrder = value; paragraphPage = 0; render(); }));
    var filtered = all.filter(function (p) {
      var bin = bins[paragraphBin];
      return !bin || (p.words >= bin.min && (bin.max == null || p.words <= bin.max));
    });
    if (paragraphOrder === "longest") filtered.sort(function (a, b) { return b.words - a.words; });
    paragraphPage = Math.min(paragraphPage, Math.max(0, Math.ceil(filtered.length / 20) - 1));
    var list = block(number(filtered.length) + " paragraphs");
    filtered.slice(paragraphPage * 20, paragraphPage * 20 + 20).forEach(function (p) {
      var row = button("", function () { hooks.openSource(p); }, "stats-paragraph");
      row.appendChild(el("strong", "", number(p.words) + " words"));
      row.appendChild(el("span", "", p.preview));
      row.appendChild(el("small", "", p.file.split("/").pop() + ":" + p.line));
      list.appendChild(row);
    });
    if (!filtered.length) list.appendChild(note("No prose paragraphs in this selection."));
    if (filtered.length > 20) pager(list, paragraphPage, Math.ceil(filtered.length / 20), function (i) { paragraphPage = i; render(); }, "paragraph page");
    content.appendChild(note(data.method.paragraphs));
  }
  function pager(parent, index, count, action, name) {
    var nav = el("div", "stats-pager");
    var prev = button("‹", function () { action(index - 1); });
    prev.disabled = index <= 0; prev.setAttribute("aria-label", "Previous " + name);
    var next = button("›", function () { action(index + 1); });
    next.disabled = index >= count - 1; next.setAttribute("aria-label", "Next " + name);
    nav.appendChild(prev); nav.appendChild(el("span", "", (index + 1) + " / " + count)); nav.appendChild(next);
    parent.appendChild(nav);
  }
  function repositoryView() {
    var repo = repository;
    if (!repo) {
      content.appendChild(note(busy ? "Reading the repository…" : "Repository composition is loading."));
      return;
    }
    cards([["Repository files", repo.files], ["Size on disk", bytes(repo.bytes), true]]);
    content.appendChild(note(repo.scope));
    content.appendChild(select("Measure", [["bytes", "Size in bytes"], ["files", "Number of files"]],
      repoMeasure, function (value) { repoMeasure = value; render(); }));
    content.appendChild(select("Include", [["source", "Text / code only"], ["all", "All types, including assets"]],
      sourceOnly ? "source" : "all", function (value) { sourceOnly = value === "source"; render(); }));
    var groups = repo.groups.filter(function (g) { return !sourceOnly || g.source; });
    groups.sort(function (a, b) { return b[repoMeasure] - a[repoMeasure]; });
    var total = groups.reduce(function (sum, g) { return sum + g[repoMeasure]; }, 0);
    var chart = block("Repository composition");
    var stacked = el("div", "stats-composition"); stacked.setAttribute("aria-hidden", "true");
    groups.forEach(function (g, i) {
      var segment = el("span", ""); segment.style.width = (total ? 100 * g[repoMeasure] / total : 0) + "%";
      segment.style.background = colors[i % colors.length]; stacked.appendChild(segment);
    });
    chart.appendChild(stacked);
    chart.appendChild(note("Denominator: " + (repoMeasure === "bytes" ? bytes(total) : number(total) + " files") +
      (sourceOnly ? " of text / code files." : " across all included file types.")));
    groups.forEach(function (g, i) {
      var percent = total ? 100 * g[repoMeasure] / total : 0;
      chart.appendChild(bar(g.name, g[repoMeasure], total, percent.toFixed(1) + "%", null, colors[i % colors.length]));
      chart.appendChild(note(number(g.files) + " files · " + bytes(g.bytes)));
    });
    content.appendChild(note("File types are classified by extension. Percentages describe saved repository files, not word counts or a GitHub language analysis."));
  }
  function render() {
    if (!data) return;
    content.replaceChildren();
    if (!data.document.sections[sectionId]) sectionId = 0;
    var problems = data.document.warnings.concat(repository && view === "repository" ? repository.warnings : []);
    if (problems.length) {
      var warning = el("details", "stats-warning");
      warning.appendChild(el("summary", "", "Partial analysis: " + problems.length + " problem" + (problems.length === 1 ? "" : "s")));
      problems.forEach(function (message) { warning.appendChild(note(message)); });
      content.appendChild(warning);
    }
    var remarks = data.document.notes || [];
    if (remarks.length && view !== "repository") {
      var notes = el("details", "stats-notes");
      notes.appendChild(el("summary", "", remarks.length + " note" + (remarks.length === 1 ? "" : "s") + " on scope"));
      remarks.forEach(function (message) { notes.appendChild(note(message)); });
      content.appendChild(notes);
    }
    ({ overview: overview, paragraphs: paragraphs, repository: repositoryView })[view]();
  }
  function changeView(next) {
    view = next;
    panel.querySelectorAll("[data-stats-tab]").forEach(function (node) {
      var active = node.dataset.statsTab === view;
      node.classList.toggle("active", active); node.setAttribute("aria-pressed", String(active));
    });
    render();
  }
  function setStatus(text, working) {
    status.textContent = text;
    status.classList.toggle("busy", !!working);
  }
  async function refresh() {
    if (busy) { pending = true; return; }
    busy = true;
    var requestedRevision = revision;
    var wantRepository = view === "repository";
    refreshButton.disabled = true;
    panel.setAttribute("aria-busy", "true");
    setStatus(wantRepository ? "Reading the repository…" : "Counting…", true);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var response = await fetch("/api/statistics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: hooks.getOverrides(), repository: wantRepository }), signal: controller.signal
      });
      var result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Statistics unavailable. Restart the editor server.");
      data = result;
      if (result.repository) repository = result.repository;
      var unsaved = data.document.unsaved_files.length;
      setStatus("Updated " + new Date(data.generated_at).toLocaleTimeString() +
        (unsaved ? " · includes " + unsaved + " unsaved file" + (unsaved === 1 ? "" : "s") : "") +
        (typeof data.elapsed_ms === "number" ? " · " + data.elapsed_ms + " ms" : "") +
        (revision !== requestedRevision ? " · newer edits pending" : ""), false);
      var scroll = content.scrollTop;
      render(); content.scrollTop = scroll;
    } catch (err) {
      setStatus((data ? "Previous snapshot · " : "") +
        (err.name === "AbortError" ? "Scan timed out. Retry with Refresh." : err.message), false);
      if (!data) content.replaceChildren(note("Statistics could not be loaded. Press Refresh to retry."));
    } finally {
      clearTimeout(timeout); busy = false; refreshButton.disabled = false; panel.setAttribute("aria-busy", "false");
      if (pending) { pending = false; if (visible()) refresh(); }
    }
  }
  function scheduleRefresh(delay) {
    if (!visible()) return;
    clearTimeout(timer); timer = setTimeout(refresh, delay || 120);
  }
  window.FaradayStatistics = {
    init: function (callbacks) {
      hooks = callbacks; panel = $("panel-statistics"); content = $("stats-content");
      status = $("stats-status"); refreshButton = $("stats-refresh");
      refreshButton.addEventListener("click", function () { refresh(); });
      document.querySelector('[data-panel="panel-statistics"]').addEventListener("click", function () { scheduleRefresh(60); });
      panel.querySelectorAll("[data-stats-tab]").forEach(function (node) {
        node.addEventListener("click", function () {
          changeView(node.dataset.statsTab);
          if (node.dataset.statsTab === "repository" || !data) scheduleRefresh(40);
        });
      });
      document.addEventListener("faraday:file-activated", function () { scheduleRefresh(400); });
      document.addEventListener("faraday:model-changed", function () {
        revision += 1;
        if (data && visible() && !busy) setStatus("Text changed · counts refresh after the next save", false);
      });
      document.addEventListener("faraday:disk-changed", function () { revision += 1; scheduleRefresh(700); });
      window.addEventListener("focus", function () { scheduleRefresh(300); });
    }
  };
})();
