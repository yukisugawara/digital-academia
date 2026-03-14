(async function () {
  // ===== i18n =====
  let lang = localStorage.getItem("da-lang") || "ja";

  function t(ja, en) { return lang === "en" ? (en || ja) : ja; }

  function applyLang() {
    document.querySelectorAll("[data-i18n-ja]").forEach((el) => {
      el.textContent = lang === "en" ? el.dataset.i18nEn : el.dataset.i18nJa;
    });
    document.querySelectorAll("[data-i18n-ph-ja]").forEach((el) => {
      el.placeholder = lang === "en" ? el.dataset.i18nPhEn : el.dataset.i18nPhJa;
    });
    const searchIn = document.getElementById("search-input");
    if (searchIn) searchIn.placeholder = t("検索...", "Search...");
    const langBtn = document.getElementById("lang-toggle");
    if (langBtn) langBtn.textContent = lang === "en" ? "JA" : "EN";
  }

  const langToggleBtn = document.getElementById("lang-toggle");
  if (langToggleBtn) langToggleBtn.addEventListener("click", () => {
    lang = lang === "ja" ? "en" : "ja";
    localStorage.setItem("da-lang", lang);
    applyLang();
    if (typeof buildLegend === "function") buildLegend();
    // Re-show panel if one is open
    if (selectedNode) {
      if (currentDatasetKey === "researcher") showResearcherPanel(selectedNode);
      else showPanel(selectedNode);
    }
  });

  const DATASETS = {
    syllabus: { url: "network_data.json", label: "授業ネットワーク", type: "syllabus" },
    researcher: { url: "researcher_network_data.json", label: "研究業績ネットワーク", type: "researcher" },
  };

  const dataCache = {};

  let currentDatasetKey = "syllabus";
  let nodes, edges, idToIndex, edgeIndices, adjacency;
  let instructorMap;
  let clusterColors, clusterCounts, clusterSamples, clusterLabels;
  let clusterLabelsJa, clusterLabelsEn;
  let N_CLUSTERS;

  // Cross-link: researcher name → researcher node id
  let researcherNameToId = {};

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  let W, H, dpr = window.devicePixelRatio || 1;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  let camX = 0, camY = 0, camZoom = 1;
  let layoutMode = "umap", layoutTransition = 1, alpha = 0.01;
  let dragging = false, dragStartX, dragStartY, camStartX, camStartY;
  let mouseDownTime = 0;
  let selectedNode = null, hoveredNode = null, activeCluster = null;
  let highlightedNodes = new Set(), highlightPulse = 0;
  let suggestionIndex = -1, currentSuggestions = [];

  // ===== Preload researcher data for cross-linking =====
  async function preloadResearcherNames() {
    try {
      if (!dataCache.researcher) {
        const r = await fetch(DATASETS.researcher.url);
        dataCache.researcher = await r.json();
      }
      researcherNameToId = {};
      for (const n of dataCache.researcher.nodes) {
        researcherNameToId[n.label.trim()] = n.id;
      }
    } catch (e) { /* ignore */ }
  }

  // ===== Load dataset =====
  async function loadDataset(key) {
    const ds = DATASETS[key];
    if (!dataCache[key]) {
      const r = await fetch(ds.url);
      dataCache[key] = await r.json();
      // Store original x/y on first load
      for (const n of dataCache[key].nodes) {
        n._origX = n.x; n._origY = n.y;
      }
    }
    const data = dataCache[key];
    currentDatasetKey = key;

    nodes = data.nodes;
    edges = data.edges;

    idToIndex = new Map();
    nodes.forEach((n, i) => {
      idToIndex.set(n.id, i);
      n.umapX = n._origX || 0; n.umapY = n._origY || 0;
      n.x = n.umapX; n.y = n.umapY;
      n.forceX = (Math.random() - 0.5) * 800; n.forceY = (Math.random() - 0.5) * 800;
      n.vx = 0; n.vy = 0; n.degree = 0;
    });

    edgeIndices = edges.map((e) => {
      const si = idToIndex.get(e.source), ti = idToIndex.get(e.target);
      if (si !== undefined) nodes[si].degree++;
      if (ti !== undefined) nodes[ti].degree++;
      return { si, ti, weight: e.weight };
    });

    adjacency = new Map();
    edges.forEach((e) => {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      if (!adjacency.has(e.target)) adjacency.set(e.target, []);
      adjacency.get(e.source).push({ id: e.target, weight: e.weight });
      adjacency.get(e.target).push({ id: e.source, weight: e.weight });
    });

    const maxCluster = Math.max(...nodes.map((n) => n.cluster), 0);
    N_CLUSTERS = maxCluster + 1;
    clusterColors = [];
    for (let i = 0; i < N_CLUSTERS; i++) clusterColors.push((i * 360 / N_CLUSTERS + 200) % 360);

    // Syllabus (faculty nodes): 9 clusters
    const SYLLABUS_LABELS_JA = { 0:"ドイツ・北欧・美術史",1:"西洋文学・古代史・哲学",2:"臨床哲学・デジタル人文学・対話",3:"東南アジア・国際関係・地域研究",4:"倫理学・法制史・フランス文学",5:"言語学・言語教育・音韻論",6:"文化人類学・教育実践・比較文化",7:"中国学・東洋史・漢文",8:"日本文学・近現代国際関係・比較文化" };
    const SYLLABUS_LABELS_EN = { 0:"German / Northern European / Art History",1:"Western Literature / Ancient History / Philosophy",2:"Clinical Philosophy / Digital Humanities / Dialogue",3:"Southeast Asia / International Relations",4:"Ethics / Legal History / French Literature",5:"Linguistics / Language Education / Phonology",6:"Cultural Anthropology / Educational Practice",7:"Chinese Studies / Eastern History",8:"Japanese Literature / Modern International Relations" };
    // Researcher: 8 clusters
    const RESEARCHER_LABELS_JA = { 0:"文学研究・比較文化・言語学",1:"英米文学・哲学・演劇",2:"言語学・教育実践・デジタル人文学",3:"近現代国際関係・移民・異文化交流",4:"東洋学・仏教学・中東・南アジア",5:"中国学・東洋史・漢文",6:"臨床哲学・ケアの倫理・対話",7:"フランス文学・西洋古代史・法制史" };
    const RESEARCHER_LABELS_EN = { 0:"Literary Studies / Comparative Culture / Linguistics",1:"English & American Lit. / Philosophy / Drama",2:"Linguistics / Educational Practice / Digital Humanities",3:"Modern International Relations / Migration",4:"Oriental Studies / Buddhism / Middle East & South Asia",5:"Chinese Studies / Eastern History",6:"Clinical Philosophy / Ethics of Care / Dialogue",7:"French Literature / Western Ancient History / Legal History" };

    // Store all label sets for language switching
    const labelsJa = ds.type === "syllabus" ? SYLLABUS_LABELS_JA : RESEARCHER_LABELS_JA;
    const labelsEn = ds.type === "syllabus" ? SYLLABUS_LABELS_EN : RESEARCHER_LABELS_EN;

    clusterCounts = new Array(N_CLUSTERS).fill(0);
    clusterSamples = new Array(N_CLUSTERS).fill(null).map(() => []);
    nodes.forEach((n) => {
      const c = n.cluster;
      if (c >= 0 && c < N_CLUSTERS) {
        clusterCounts[c]++;
        if (clusterSamples[c].length < 3) {
          const sample = (ds.type === "syllabus" ? (n.subtitle || n.label || "") : (n.label || "")).replace(/^\[科目\]/, "");
          if (sample) clusterSamples[c].push(sample.slice(0, 25));
        }
      }
    });

    // clusterLabels is now a function of current lang
    clusterLabelsJa = Array.from({ length: N_CLUSTERS }, (_, i) => labelsJa[i] || `Topic ${i}`);
    clusterLabelsEn = Array.from({ length: N_CLUSTERS }, (_, i) => labelsEn[i] || `Topic ${i}`);
    clusterLabels = lang === "en" ? clusterLabelsEn : clusterLabelsJa;

    camX = 0; camY = 0; camZoom = 1;
    layoutMode = "umap"; layoutTransition = 1; alpha = 0.01;
    selectedNode = null; hoveredNode = null; activeCluster = null;
    dragging = false;
    highlightedNodes = new Set(); edgeParticles.length = 0;
    searchInput.value = "";
    suggestions.classList.remove("active");
    hidePanel(); hideInstructorPanel(); hideResearcherPanel();
    zoomSlider.value = 1; zoomLabel.textContent = "100%";
    toggleBtn.textContent = "UMAP"; toggleBtn.classList.add("active");
    buildLegend(); updateModeButtons();

    // Handle URL params after load
    handleUrlParams();
  }

  // ===== URL params (feature 9) =====
  function handleUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    const nodeId = params.get("node");
    if (mode && mode !== currentDatasetKey && DATASETS[mode]) {
      loadDataset(mode);
      return;
    }
    if (nodeId && idToIndex.has(nodeId)) {
      const n = nodes[idToIndex.get(nodeId)];
      selectedNode = n;
      highlightedNodes = new Set([n.id]);
      highlightPulse = 0;
      if (currentDatasetKey === "researcher") showResearcherPanel(n);
      else showPanel(n);
      setTimeout(() => animateCameraTo(n.x, n.y, 1.2), 100);
    }
  }

  function updateUrl(nodeId) {
    const url = new URL(window.location);
    url.searchParams.set("mode", currentDatasetKey);
    if (nodeId) url.searchParams.set("node", nodeId);
    else url.searchParams.delete("node");
    window.history.replaceState({}, "", url);
  }

  function copyShareUrl(nodeId) {
    const url = new URL(window.location);
    url.searchParams.set("mode", currentDatasetKey);
    url.searchParams.set("node", nodeId);
    navigator.clipboard.writeText(url.toString()).then(() => showToast("URLをコピーしました"));
  }

  // ===== Toast =====
  const toastEl = document.getElementById("toast");
  let toastTimer;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2000);
  }

  // ===== Mode switch =====
  const modeBtns = document.querySelectorAll(".mode-btn");
  function updateModeButtons() {
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === currentDatasetKey));
  }
  modeBtns.forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.dataset.mode !== currentDatasetKey) {
        try {
          await loadDataset(b.dataset.mode);
        } catch (err) {
          console.error("Failed to switch dataset:", err);
        }
      }
    });
  });

  // ===== Zoom =====
  const zoomSlider = document.getElementById("zoom-slider");
  const zoomLabel = document.getElementById("zoom-label");
  zoomSlider.addEventListener("input", () => {
    camZoom = parseFloat(zoomSlider.value);
    zoomLabel.textContent = Math.round(camZoom * 100) + "%";
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camZoom = Math.max(0.05, Math.min(3, camZoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    zoomSlider.value = camZoom;
    zoomLabel.textContent = Math.round(camZoom * 100) + "%";
  }, { passive: false });

  // ===== Home / reset view =====
  function resetView() {
    selectedNode = null; highlightedNodes.clear(); activeCluster = null;
    hidePanel(); hideResearcherPanel();
    const startX = camX, startY = camY, startZ = camZoom;
    const duration = 600, start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      camX = startX * (1 - ease); camY = startY * (1 - ease);
      camZoom = startZ + (1 - startZ) * ease;
      zoomSlider.value = camZoom;
      zoomLabel.textContent = Math.round(camZoom * 100) + "%";
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  document.getElementById("home-btn").addEventListener("click", resetView);
  const homeLogo = document.getElementById("home-logo");
  if (homeLogo) homeLogo.addEventListener("click", () => {
    // Return to auth/start screen
    sessionStorage.removeItem("da-auth");
    window.location.reload();
  });

  // ===== Touch support (feature 10) =====
  let touches = [];
  let lastPinchDist = 0;
  let touchPanStartX, touchPanStartY, touchCamStartX, touchCamStartY;

  let touchDraggedNode = null;

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    touches = Array.from(e.touches);
    if (touches.length === 1) {
      const mx = (touches[0].clientX - W / 2) / camZoom - camX;
      const my = (touches[0].clientY - H / 2) / camZoom - camY;
      const hit = findNode(mx, my);
      if (hit) {
        touchDraggedNode = hit;
      } else {
        touchDraggedNode = null;
        touchPanStartX = touches[0].clientX; touchPanStartY = touches[0].clientY;
        touchCamStartX = camX; touchCamStartY = camY;
      }
      mouseDownTime = Date.now();
    } else if (touches.length === 2) {
      touchDraggedNode = null;
      lastPinchDist = Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const ts = Array.from(e.touches);
    if (ts.length === 1 && touchDraggedNode) {
      const mx = (ts[0].clientX - W / 2) / camZoom - camX;
      const my = (ts[0].clientY - H / 2) / camZoom - camY;
      touchDraggedNode.umapX = mx; touchDraggedNode.umapY = my;
      touchDraggedNode._origX = mx; touchDraggedNode._origY = my;
    } else if (ts.length === 1 && !touchDraggedNode) {
      camX = touchCamStartX + (ts[0].clientX - touchPanStartX) / camZoom;
      camY = touchCamStartY + (ts[0].clientY - touchPanStartY) / camZoom;
    } else if (ts.length === 2) {
      const dist = Math.hypot(ts[1].clientX - ts[0].clientX, ts[1].clientY - ts[0].clientY);
      if (lastPinchDist > 0) {
        camZoom = Math.max(0.05, Math.min(3, camZoom * (dist / lastPinchDist)));
        zoomSlider.value = camZoom;
        zoomLabel.textContent = Math.round(camZoom * 100) + "%";
      }
      lastPinchDist = dist;
    }
  }, { passive: false });

  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (e.changedTouches.length === 1 && Date.now() - mouseDownTime < 300 && touchDraggedNode) {
      selectedNode = touchDraggedNode;
      highlightedNodes = new Set([touchDraggedNode.id]); highlightPulse = 0;
      if (currentDatasetKey === "researcher") showResearcherPanel(touchDraggedNode);
      else showPanel(touchDraggedNode);
    } else if (e.changedTouches.length === 1 && Date.now() - mouseDownTime < 300 && !touchDraggedNode) {
      const t = e.changedTouches[0];
      const mx = (t.clientX - W / 2) / camZoom - camX;
      const my = (t.clientY - H / 2) / camZoom - camY;
      const clicked = findNode(mx, my);
      if (clicked) {
        selectedNode = clicked;
        highlightedNodes = new Set([clicked.id]); highlightPulse = 0;
        if (currentDatasetKey === "researcher") showResearcherPanel(clicked);
        else showPanel(clicked);
      } else {
        selectedNode = null; highlightedNodes.clear(); hidePanel(); hideResearcherPanel();
      }
    }
    touchDraggedNode = null;
    touches = Array.from(e.touches);
    lastPinchDist = 0;
  }, { passive: false });

  // ===== Mouse pan, click & node drag =====
  let draggedNode = null;

  canvas.addEventListener("mousedown", (e) => {
    mouseDownTime = Date.now();
    const mx = (e.clientX - W / 2) / camZoom - camX;
    const my = (e.clientY - H / 2) / camZoom - camY;
    const hit = findNode(mx, my);
    if (hit) {
      draggedNode = hit;
      canvas.style.cursor = "grabbing";
    } else {
      draggedNode = null;
      dragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
      camStartX = camX; camStartY = camY;
    }
  });
  canvas.addEventListener("mousemove", (e) => {
    const mx = (e.clientX - W / 2) / camZoom - camX;
    const my = (e.clientY - H / 2) / camZoom - camY;
    if (draggedNode) {
      draggedNode.umapX = mx; draggedNode.umapY = my;
      draggedNode._origX = mx; draggedNode._origY = my;
      canvas.style.cursor = "grabbing";
    } else if (dragging) {
      camX = camStartX + (e.clientX - dragStartX) / camZoom;
      camY = camStartY + (e.clientY - dragStartY) / camZoom;
    } else {
      hoveredNode = findNode(mx, my);
      canvas.style.cursor = hoveredNode ? "pointer" : "grab";
    }
  });
  canvas.addEventListener("mouseup", (e) => {
    const wasNodeDrag = draggedNode !== null;
    const wasDragging = dragging;
    dragging = false;

    if (wasNodeDrag && Date.now() - mouseDownTime < 200) {
      selectedNode = draggedNode;
      highlightedNodes = new Set([draggedNode.id]); highlightPulse = 0;
      if (currentDatasetKey === "researcher") showResearcherPanel(draggedNode);
      else showPanel(draggedNode);
    } else if (!wasNodeDrag && !wasDragging) {
      // Click on empty space
    } else if (!wasNodeDrag && Date.now() - mouseDownTime < 250) {
      const mx = (e.clientX - W / 2) / camZoom - camX;
      const my = (e.clientY - H / 2) / camZoom - camY;
      const clicked = findNode(mx, my);
      if (clicked) {
        selectedNode = clicked;
        highlightedNodes = new Set([clicked.id]); highlightPulse = 0;
        if (currentDatasetKey === "researcher") showResearcherPanel(clicked);
        else showPanel(clicked);
      } else { selectedNode = null; highlightedNodes.clear(); hidePanel(); hideResearcherPanel(); }
    }
    draggedNode = null;
  });

  function findNode(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], r = nodeRadius(n);
      const dx = n.x - mx, dy = n.y - my;
      if (dx * dx + dy * dy < (r + 4) * (r + 4)) return n;
    }
    return null;
  }

  function nodeRadius(n) {
    return currentDatasetKey === "researcher" ? 4 + Math.sqrt(n.degree) * 1.5 : 3 + Math.sqrt(n.degree) * 1.2;
  }

  // ===== Layout toggle =====
  const toggleBtn = document.getElementById("toggle-layout");
  toggleBtn.classList.add("active");
  toggleBtn.addEventListener("click", () => {
    if (layoutMode === "umap") { layoutMode = "force"; toggleBtn.textContent = "Force"; toggleBtn.classList.remove("active"); alpha = 1; }
    else { layoutMode = "umap"; toggleBtn.textContent = "UMAP"; toggleBtn.classList.add("active"); }
  });

  // ===== Legend with tooltip (features 5) =====
  const legendEl = document.getElementById("legend");
  const clusterTooltip = document.getElementById("cluster-tooltip");

  function buildLegend() {
    // Refresh labels for current language
    if (clusterLabelsJa && clusterLabelsEn) {
      clusterLabels = lang === "en" ? clusterLabelsEn : clusterLabelsJa;
    }
    let html = '<div class="legend-title">TOPIC CLUSTERS</div>';
    for (let i = 0; i < N_CLUSTERS; i++) {
      if (clusterCounts[i] === 0) continue;
      html += `<div class="legend-item" data-cluster="${i}">
        <span class="legend-dot" style="background:hsl(${clusterColors[i]},65%,55%)"></span>
        <span class="legend-label">${escapeHtml(clusterLabels[i])}</span>
        <span class="legend-count">${clusterCounts[i]}</span>
      </div>`;
    }
    legendEl.innerHTML = html;

    legendEl.querySelectorAll(".legend-item").forEach((el) => {
      el.addEventListener("click", () => {
        const c = parseInt(el.dataset.cluster);
        activeCluster = activeCluster === c ? null : c;
      });
      el.addEventListener("mouseenter", (e) => {
        const c = parseInt(el.dataset.cluster);
        const samples = clusterSamples[c] || [];
        if (samples.length === 0) return;
        clusterTooltip.innerHTML = `<div class="ct-title">${escapeHtml(clusterLabels[c])}</div>` +
          samples.map((s) => `<div class="ct-sample">${escapeHtml(s)}</div>`).join("");
        clusterTooltip.style.display = "block";
        const rect = el.getBoundingClientRect();
        clusterTooltip.style.left = (rect.right + 8) + "px";
        clusterTooltip.style.top = rect.top + "px";
      });
      el.addEventListener("mouseleave", () => { clusterTooltip.style.display = "none"; });
    });
  }

  // ===== Search =====
  const searchInput = document.getElementById("search-input");
  const suggestions = document.getElementById("search-suggestions");

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    suggestionIndex = -1;
    if (!q) { suggestions.classList.remove("active"); highlightedNodes.clear(); return; }
    // Both modes: nodes are people (faculty or researchers)
    currentSuggestions = nodes.filter((n) => {
      const l = (n.label||"").toLowerCase(), le = (n.label_en||"").toLowerCase();
      const a = (n.affiliation||"").toLowerCase();
      // Search in courses (syllabus) or titles (researcher)
      const extra = currentDatasetKey === "syllabus"
        ? (n.courses||[]).map(c => c.label + " " + c.subtitle).join(" ").toLowerCase()
        : (n.top_titles||[]).join(" ").toLowerCase();
      return l.includes(q) || le.includes(q) || a.includes(q) || extra.includes(q);
    }).slice(0, 15).map((n) => ({ type: "node", node: n }));
    renderSuggestions(currentSuggestions, q);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (!suggestions.classList.contains("active")) return;
    const items = suggestions.querySelectorAll("li");
    if (e.key === "ArrowDown") { e.preventDefault(); suggestionIndex = Math.min(suggestionIndex + 1, items.length - 1); updateSuggestionHighlight(items); }
    else if (e.key === "ArrowUp") { e.preventDefault(); suggestionIndex = Math.max(suggestionIndex - 1, 0); updateSuggestionHighlight(items); }
    else if (e.key === "Enter") { e.preventDefault(); if (suggestionIndex >= 0 && suggestionIndex < currentSuggestions.length) selectSuggestionItem(currentSuggestions[suggestionIndex]); else if (currentSuggestions.length > 0) selectSuggestionItem(currentSuggestions[0]); }
    else if (e.key === "Escape") { suggestions.classList.remove("active"); searchInput.blur(); }
  });

  function updateSuggestionHighlight(items) {
    items.forEach((li, i) => li.classList.toggle("selected", i === suggestionIndex));
    if (items[suggestionIndex]) items[suggestionIndex].scrollIntoView({ block: "nearest" });
  }

  function renderSuggestions(results, q) {
    if (!results.length) { suggestions.classList.remove("active"); return; }
    suggestions.innerHTML = results.map((item, i) => {
      const n = item.node;
      const aff = n.affiliation || "";
      const rank = n.rank || "";
      const detail = currentDatasetKey === "researcher"
        ? `${escapeHtml(aff)} ${escapeHtml(rank)} / ${t("業績","publications")} ${n.achievement_count||0} ${t("件","")}`
        : `${escapeHtml(aff)} ${escapeHtml(rank)} / ${n.course_count||0} ${t("科目","courses")}`;
      return `<li data-index="${i}"><div>${highlightMatch(n.label, q)}</div><div class="suggestion-sub">${detail}</div></li>`;
    }).join("");
    suggestions.classList.add("active");
    suggestions.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => selectSuggestionItem(currentSuggestions[parseInt(li.dataset.index)]));
    });
  }

  function selectSuggestionItem(item) {
    suggestions.classList.remove("active");
    selectSearchResult(item.node);
  }

  function selectSearchResult(n) {
    highlightedNodes = new Set([n.id]); highlightPulse = 0;
    selectedNode = n;
    suggestions.classList.remove("active"); searchInput.value = n.label;
    if (currentDatasetKey === "researcher") { showResearcherPanel(n); hidePanel(); }
    else { showPanel(n); hideResearcherPanel(); }
    animateCameraTo(n.x, n.y, 1.2);
    updateUrl(n.id);
  }

  function highlightMatch(text, q) {
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx)) + `<strong style="color:#b8a0ff">${escapeHtml(text.slice(idx, idx + q.length))}</strong>` + escapeHtml(text.slice(idx + q.length));
  }
  function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function animateCameraTo(tx, ty, tz) {
    const sX = camX, sY = camY, sZ = camZoom, tX = -tx, tY = -ty;
    const dur = 600, st = performance.now();
    function step(now) {
      const t = Math.min((now - st) / dur, 1), ease = 1 - Math.pow(1 - t, 3);
      camX = sX + (tX - sX) * ease; camY = sY + (tY - sY) * ease;
      camZoom = sZ + (tz - sZ) * ease;
      zoomSlider.value = camZoom; zoomLabel.textContent = Math.round(camZoom * 100) + "%";
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  document.addEventListener("click", (e) => { if (!e.target.closest("#search-box")) suggestions.classList.remove("active"); });

  // ===== Faculty panel (syllabus mode) =====
  const panel = document.getElementById("info-panel");
  const panelTitle = document.getElementById("panel-title");
  const panelTitleEn = document.getElementById("panel-title-en");
  const panelAffiliation = document.getElementById("panel-affiliation");
  const panelRank = document.getElementById("panel-rank");
  const panelCluster = document.getElementById("panel-cluster");
  const panelCrosslink = document.getElementById("panel-crosslink");
  const panelCourseCount = document.getElementById("panel-course-count");
  const panelCourses = document.getElementById("panel-courses");
  const panelRelated = document.getElementById("panel-related");

  document.getElementById("panel-close").addEventListener("click", () => { selectedNode = null; hidePanel(); });
  document.getElementById("panel-share").addEventListener("click", () => { if (selectedNode) copyShareUrl(selectedNode.id); });

  function showPanel(n) {
    const isEn = lang === "en";
    panelTitle.textContent = isEn ? (n.label_en || n.label) : n.label;
    panelTitleEn.textContent = isEn ? n.label : (n.label_en || "");
    panelAffiliation.textContent = n.affiliation || "";
    panelRank.textContent = n.rank || "";
    panelCluster.textContent = clusterLabels[n.cluster] || `Topic ${n.cluster}`;
    panelCluster.style.borderColor = `hsl(${clusterColors[n.cluster]},60%,50%)`;
    panelCluster.style.color = `hsl(${clusterColors[n.cluster]},70%,65%)`;

    // Cross-link to researcher network
    if (researcherNameToId[n.label]) {
      const linkText = t("研究業績ネットワークで見る", "View in Research Network");
      panelCrosslink.innerHTML = `<button class="crosslink-btn">&#8594; ${escapeHtml(linkText)}</button>`;
      panelCrosslink.querySelector("button").addEventListener("click", async () => {
        const rid = researcherNameToId[n.label];
        hidePanel();
        await loadDataset("researcher");
        const rn = nodes[idToIndex.get(rid)];
        if (rn) { selectedNode = rn; highlightedNodes = new Set([rn.id]); highlightPulse = 0; showResearcherPanel(rn); setTimeout(() => animateCameraTo(rn.x, rn.y, 1.2), 100); }
      });
    } else { panelCrosslink.innerHTML = ""; }

    panelCourseCount.textContent = `${n.course_count || 0} ${t("科目", "courses")}`;

    const courses = n.courses || [];
    panelCourses.innerHTML = courses.map((c) => {
      const name = isEn ? (c.label_en || c.label) : c.label;
      const sub = isEn ? (c.subtitle_en || c.subtitle || "") : (c.subtitle || "");
      const sem = isEn ? (c.semester_en || c.semester || "") : (c.semester || "");
      return `<li><div class="instr-course-name">${escapeHtml(name.replace(/^\[科目\]/,""))}</div><div class="instr-course-sub">${escapeHtml(sem)}${sub ? " — " + escapeHtml(sub) : ""}</div></li>`;
    }).join("");

    const related = (adjacency.get(n.id)||[]).sort((a, b) => b.weight - a.weight).slice(0, 10);
    panelRelated.innerHTML = related.map((r) => {
      const rn = nodes[idToIndex.get(r.id)]; if (!rn) return "";
      const name = isEn ? (rn.label_en || rn.label) : rn.label;
      return `<li data-id="${r.id}">${escapeHtml(name)}<span class="rel-score">${Math.round(r.weight*100)}%</span></li>`;
    }).join("");
    panelRelated.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const rn = nodes[idToIndex.get(li.dataset.id)];
        if (rn) { selectedNode = rn; showPanel(rn); animateCameraTo(rn.x, rn.y, 1.2); highlightedNodes = new Set([rn.id]); highlightPulse = 0; updateUrl(rn.id); }
      });
    });
    panel.classList.remove("hidden");
    updateUrl(n.id);
  }
  function hidePanel() { panel.classList.add("hidden"); }

  // Stub for backward compat
  function hideInstructorPanel() {}

  // ===== Researcher panel with cross-link (feature 4) =====
  const resPanel = document.getElementById("researcher-panel");
  const resPanelName = document.getElementById("res-panel-name");
  const resPanelNameEn = document.getElementById("res-panel-name-en");
  const resPanelAff = document.getElementById("res-panel-affiliation");
  const resPanelRank = document.getElementById("res-panel-rank");
  const resPanelCluster = document.getElementById("res-panel-cluster");
  const resPanelCrosslink = document.getElementById("res-panel-crosslink");
  const resPanelCount = document.getElementById("res-panel-count");
  const resPanelTitles = document.getElementById("res-panel-titles");
  const resPanelRelated = document.getElementById("res-panel-related");

  document.getElementById("res-panel-close").addEventListener("click", () => { selectedNode = null; hideResearcherPanel(); });
  document.getElementById("res-panel-share").addEventListener("click", () => { if (selectedNode) copyShareUrl(selectedNode.id); });

  function showResearcherPanel(n) {
    const isEn = lang === "en";
    resPanelName.textContent = isEn ? (n.label_en || n.label) : n.label;
    resPanelNameEn.textContent = isEn ? n.label : (n.label_en || "");
    resPanelAff.textContent = n.affiliation || "";
    resPanelRank.textContent = n.rank || "";
    resPanelCluster.textContent = clusterLabels[n.cluster] || `Topic ${n.cluster}`;
    resPanelCluster.style.borderColor = `hsl(${clusterColors[n.cluster]},60%,50%)`;
    resPanelCluster.style.color = `hsl(${clusterColors[n.cluster]},70%,65%)`;
    resPanelCount.textContent = `${n.achievement_count||0} ${t("件", "items")}`;

    // Cross-link to syllabus (same sid = same node in syllabus network)
    const syllabusData = dataCache.syllabus;
    let hasSyllabus = false;
    if (syllabusData) {
      const sylNode = syllabusData.nodes.find((sn) => sn.id === n.id || sn.label.trim() === n.label.trim());
      if (sylNode) {
        hasSyllabus = true;
        const linkText = t("授業ネットワークで見る", "View in Course Network");
        resPanelCrosslink.innerHTML = `<button class="crosslink-btn">&#8594; ${escapeHtml(linkText)}</button>`;
        resPanelCrosslink.querySelector("button").addEventListener("click", async () => {
          hideResearcherPanel();
          await loadDataset("syllabus");
          const sn = nodes[idToIndex.get(sylNode.id)];
          if (sn) { selectedNode = sn; highlightedNodes = new Set([sn.id]); highlightPulse = 0; showPanel(sn); setTimeout(() => animateCameraTo(sn.x, sn.y, 1.2), 100); }
        });
      }
    }
    if (!hasSyllabus) resPanelCrosslink.innerHTML = "";

    const titles = isEn ? (n.top_titles_en && n.top_titles_en.length ? n.top_titles_en : n.top_titles || []) : (n.top_titles || []);
    resPanelTitles.innerHTML = titles.map((ti) => `<li>${escapeHtml(ti)}</li>`).join("");

    const related = (adjacency.get(n.id)||[]).sort((a, b) => b.weight - a.weight).slice(0, 10);
    resPanelRelated.innerHTML = related.map((r) => {
      const rn = nodes[idToIndex.get(r.id)]; if (!rn) return "";
      const name = isEn ? (rn.label_en || rn.label) : rn.label;
      return `<li data-id="${r.id}">${escapeHtml(name)}<span class="rel-score">${Math.round(r.weight*100)}%</span></li>`;
    }).join("");
    resPanelRelated.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const rn = nodes[idToIndex.get(li.dataset.id)];
        if (rn) { selectedNode = rn; showResearcherPanel(rn); animateCameraTo(rn.x, rn.y, 1.2); highlightedNodes = new Set([rn.id]); highlightPulse = 0; }
      });
    });
    resPanel.classList.remove("hidden");
    updateUrl(n.id);
  }
  function hideResearcherPanel() { resPanel.classList.add("hidden"); }

  // ===== Force simulation =====
  function simulate() {
    if (layoutMode !== "force" || alpha < 0.001) return;
    const n = nodes.length, repK = 800;
    const sampleCount = Math.min(n * 8, n * (n - 1) / 2);
    for (let s = 0; s < sampleCount; s++) {
      const i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n);
      if (i === j) continue;
      const a = nodes[i], b = nodes[j];
      let dx = a.forceX - b.forceX, dy = a.forceY - b.forceY, d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      const f = (alpha * repK) / d2;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of edgeIndices) {
      if (e.si === undefined || e.ti === undefined) continue;
      const a = nodes[e.si], b = nodes[e.ti];
      const dx = b.forceX - a.forceX, dy = b.forceY - a.forceY, f = alpha * 0.005 * e.weight;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const nd of nodes) {
      nd.vx -= nd.forceX * alpha * 0.001; nd.vy -= nd.forceY * alpha * 0.001;
      nd.vx *= 0.6; nd.vy *= 0.6; nd.forceX += nd.vx; nd.forceY += nd.vy;
    }
    alpha *= 0.997;
  }

  // Drift state: each node gets a unique slow drift
  let driftTime = 0;

  function updatePositions() {
    const tgt = layoutMode === "umap" ? 1 : 0;
    layoutTransition += (tgt - layoutTransition) * 0.08;
    driftTime += 0.003; // very slow

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const baseX = n.forceX * (1 - layoutTransition) + n.umapX * layoutTransition;
      const baseY = n.forceY * (1 - layoutTransition) + n.umapY * layoutTransition;

      // Gentle starfield drift — unique per node using index as seed
      const phase1 = i * 0.7 + driftTime;
      const phase2 = i * 1.3 + driftTime * 0.8;
      const driftX = Math.sin(phase1) * 3 + Math.sin(phase1 * 0.4) * 2;
      const driftY = Math.cos(phase2) * 3 + Math.cos(phase2 * 0.5) * 2;

      n.x = baseX + driftX;
      n.y = baseY + driftY;
    }
  }

  // ===== Ambient particles =====
  const ambientParticles = [];
  for (let i = 0; i < 50; i++) {
    ambientParticles.push({
      x: (Math.random() - 0.5) * 2000, y: (Math.random() - 0.5) * 2000,
      vx: (Math.random() - 0.5) * 0.08, vy: (Math.random() - 0.5) * 0.08,
      size: 0.4 + Math.random() * 1.2, phase: Math.random() * Math.PI * 2,
      hue: 200 + Math.random() * 160,
    });
  }

  // ===== Edge flow particles =====
  const edgeParticles = [];
  let epFrame = 0;

  function spawnEdgeParticles() {
    if (!selectedNode || edgeParticles.length > 80) return;
    const adj = adjacency.get(selectedNode.id) || [];
    for (const r of adj.slice(0, 8)) {
      const rn = nodes[idToIndex.get(r.id)]; if (!rn) continue;
      edgeParticles.push({
        sx: selectedNode.x, sy: selectedNode.y,
        tx: rn.x, ty: rn.y, t: 0, speed: 0.008 + Math.random() * 0.012,
        hue: clusterColors[selectedNode.cluster] || 200,
      });
    }
  }

  // ===== Ripple effect =====
  const ripples = [];
  function addRipple(x, y, hue) {
    ripples.push({ x, y, r: 0, maxR: 60, hue, alpha: 0.5 });
  }

  // ===== Drawing =====
  let frameTime = 0;

  function getNodeColor(n, isActive) {
    const hue = clusterColors[n.cluster] || 200;
    return isActive ? `hsla(${hue},80%,70%,0.95)` : `hsla(${hue},65%,55%,0.85)`;
  }
  function getGlowColor(n) {
    return `hsla(${clusterColors[n.cluster]||200},80%,60%,0.35)`;
  }

  function draw() {
    frameTime += 0.016;
    ctx.clearRect(0, 0, W, H);

    // Background subtle gradient
    const bgGrad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W, H) * 0.7);
    bgGrad.addColorStop(0, "rgba(15,12,30,1)");
    bgGrad.addColorStop(1, "rgba(10,10,20,1)");
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(camZoom, camZoom);
    ctx.translate(camX, camY);
    highlightPulse += 0.04;
    const clusterDim = activeCluster !== null;

    // ===== Ambient particles =====
    for (const p of ambientParticles) {
      p.x += p.vx; p.y += p.vy; p.phase += 0.008;
      if (p.x > 1200) p.x = -1200; if (p.x < -1200) p.x = 1200;
      if (p.y > 1200) p.y = -1200; if (p.y < -1200) p.y = 1200;
      const alpha = 0.15 + 0.1 * Math.sin(p.phase);
      ctx.fillStyle = `hsla(${p.hue},60%,60%,${alpha})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }

    // ===== Cluster auras =====
    if (!clusterDim && camZoom < 1.5) {
      const clusterCenters = {};
      for (const n of nodes) {
        if (!clusterCenters[n.cluster]) clusterCenters[n.cluster] = { x: 0, y: 0, count: 0 };
        clusterCenters[n.cluster].x += n.x;
        clusterCenters[n.cluster].y += n.y;
        clusterCenters[n.cluster].count++;
      }
      for (const c in clusterCenters) {
        const cc = clusterCenters[c];
        cc.x /= cc.count; cc.y /= cc.count;
        const hue = clusterColors[c] || 200;
        const auraR = 80 + cc.count * 2;
        const pulse = 0.5 + 0.15 * Math.sin(frameTime * 0.8 + parseInt(c));
        const grad = ctx.createRadialGradient(cc.x, cc.y, 0, cc.x, cc.y, auraR);
        grad.addColorStop(0, `hsla(${hue},50%,40%,${0.04 * pulse})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cc.x, cc.y, auraR, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ===== Edges =====
    for (const e of edgeIndices) {
      if (e.si === undefined || e.ti === undefined) continue;
      const a = nodes[e.si], b = nodes[e.ti];
      if (clusterDim && a.cluster !== activeCluster && b.cluster !== activeCluster) continue;
      const isSelected = selectedNode && (a.id === selectedNode.id || b.id === selectedNode.id);
      const isSearchHit = highlightedNodes.size > 0 && (highlightedNodes.has(a.id) || highlightedNodes.has(b.id));
      if (isSelected || isSearchHit) {
        const pulse = 0.7 + 0.3 * Math.sin(frameTime * 3 + e.weight * 10);
        ctx.strokeStyle = `rgba(160,120,255,${(0.3 + e.weight * 0.5) * pulse})`;
        ctx.lineWidth = 0.5 + e.weight * 2.5;
      } else {
        const dim = clusterDim ? 0.03 : 1;
        ctx.strokeStyle = `rgba(80,60,140,${(0.05 + e.weight * 0.08) * dim})`;
        ctx.lineWidth = 0.3 + e.weight * 1.0;
      }
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // ===== Edge flow particles =====
    if (++epFrame % 20 === 0) spawnEdgeParticles();
    for (let i = edgeParticles.length - 1; i >= 0; i--) {
      const p = edgeParticles[i];
      p.t += p.speed;
      if (p.t > 1) { edgeParticles.splice(i, 1); continue; }
      const x = p.sx + (p.tx - p.sx) * p.t;
      const y = p.sy + (p.ty - p.sy) * p.t;
      const alpha = Math.sin(p.t * Math.PI) * 0.8;
      const size = 1.5 + Math.sin(p.t * Math.PI) * 1.5;
      ctx.fillStyle = `hsla(${p.hue},80%,70%,${alpha})`;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
      // Trail
      const tx2 = p.sx + (p.tx - p.sx) * Math.max(0, p.t - 0.05);
      const ty2 = p.sy + (p.ty - p.sy) * Math.max(0, p.t - 0.05);
      ctx.strokeStyle = `hsla(${p.hue},60%,60%,${alpha * 0.3})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(tx2, ty2); ctx.lineTo(x, y); ctx.stroke();
    }

    // ===== Ripples =====
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += 1.5; rp.alpha -= 0.008;
      if (rp.alpha <= 0) { ripples.splice(i, 1); continue; }
      ctx.strokeStyle = `hsla(${rp.hue},70%,60%,${rp.alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2); ctx.stroke();
    }

    // ===== Nodes =====
    const active = hoveredNode || selectedNode;
    for (const n of nodes) {
      const r = nodeRadius(n);
      const isActive = active && n.id === active.id;
      const isSearchHit = highlightedNodes.has(n.id);
      const isDimmed = clusterDim && n.cluster !== activeCluster && !isActive && !isSearchHit;
      const hue = clusterColors[n.cluster] || 200;

      if (isSearchHit) {
        const pulse = 0.5 + 0.5 * Math.sin(highlightPulse);
        const glowR = r * (5 + pulse * 4);
        const grad = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, glowR);
        grad.addColorStop(0, `hsla(45,100%,70%,${0.5+pulse*0.3})`);
        grad.addColorStop(0.5, `hsla(45,100%,60%,${0.15+pulse*0.1})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `hsla(45,100%,75%,0.95)`; ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.5, 0, Math.PI * 2); ctx.fill();
        // Label
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = 'bold 11px "Hiragino Sans",sans-serif'; ctx.textAlign = "center";
        ctx.fillText(lang === "en" ? (n.label_en || n.label) : n.label, n.x, n.y - r * 1.5 - 6);
        continue;
      }
      if (isDimmed) {
        ctx.fillStyle = "rgba(60,55,80,0.25)"; ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.7, 0, Math.PI * 2); ctx.fill();
        continue;
      }

      // Outer glow
      if (isActive || n.degree > 5) {
        const glowMul = isActive ? 6 : 3;
        const grad = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, r * glowMul);
        grad.addColorStop(0, `hsla(${hue},80%,60%,${isActive ? 0.4 : 0.2})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(n.x, n.y, r * glowMul, 0, Math.PI * 2); ctx.fill();
      }

      // Node body with inner gradient
      const ng = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
      ng.addColorStop(0, `hsla(${hue},80%,75%,0.95)`);
      ng.addColorStop(1, `hsla(${hue},65%,50%,0.85)`);
      ctx.fillStyle = isActive ? ng : getNodeColor(n, false);
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();

      // Rim light
      if (isActive) {
        ctx.strokeStyle = `hsla(${hue},80%,70%,0.6)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.5, 0, Math.PI * 2); ctx.stroke();
      }

      // Labels
      if (camZoom > 0.6 || isActive) {
        const lbl = (lang === "en" ? (n.label_en || n.label) : n.label).slice(0, 15);
        const op = isActive ? 0.95 : Math.min(0.75, (camZoom - 0.4) * 1.5);
        if (op > 0) {
          ctx.fillStyle = `rgba(255,255,255,${op})`;
          const fs = Math.max(7, Math.min(11, 9 / Math.sqrt(camZoom)));
          ctx.font = `${isActive ? "bold " : ""}${fs}px "Hiragino Sans",sans-serif`;
          ctx.textAlign = "center";
          // Text shadow
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 4;
          ctx.fillText(lbl, n.x, n.y - r - 5);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  // Add ripple on node selection
  const origSelectSearchResult = selectSearchResult;
  // Patch: add ripple when clicking nodes
  canvas.addEventListener("mouseup", () => {
    if (hoveredNode) addRipple(hoveredNode.x, hoveredNode.y, clusterColors[hoveredNode.cluster] || 200);
  }, true);
  canvas.addEventListener("touchend", () => {
    if (selectedNode) addRipple(selectedNode.x, selectedNode.y, clusterColors[selectedNode.cluster] || 200);
  }, true);

  // ===== Minimap (feature 2) =====
  const minimap = document.getElementById("minimap");
  const mmCtx = minimap.getContext("2d");
  const MM_W = 160, MM_H = 120;
  minimap.width = MM_W * dpr; minimap.height = MM_H * dpr;
  minimap.style.width = MM_W + "px"; minimap.style.height = MM_H + "px";

  function drawMinimap() {
    mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mmCtx.clearRect(0, 0, MM_W, MM_H);
    if (!nodes || nodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
    const pad = 10;
    const scaleX = (MM_W - pad * 2) / rangeX, scaleY = (MM_H - pad * 2) / rangeY;
    const scale = Math.min(scaleX, scaleY);
    const offX = pad + (MM_W - pad * 2 - rangeX * scale) / 2;
    const offY = pad + (MM_H - pad * 2 - rangeY * scale) / 2;

    // Nodes
    for (const n of nodes) {
      const x = offX + (n.x - minX) * scale;
      const y = offY + (n.y - minY) * scale;
      const hue = clusterColors[n.cluster] || 200;
      mmCtx.fillStyle = `hsla(${hue},60%,55%,0.6)`;
      mmCtx.beginPath(); mmCtx.arc(x, y, 1.2, 0, Math.PI * 2); mmCtx.fill();
    }

    // Viewport rectangle
    const vl = (-camX - W / 2 / camZoom - minX) * scale + offX;
    const vt = (-camY - H / 2 / camZoom - minY) * scale + offY;
    const vw = (W / camZoom) * scale;
    const vh = (H / camZoom) * scale;
    mmCtx.strokeStyle = "rgba(255,255,255,0.5)"; mmCtx.lineWidth = 1;
    mmCtx.strokeRect(vl, vt, vw, vh);
  }

  // Minimap click to navigate
  minimap.addEventListener("click", (e) => {
    if (!nodes || nodes.length === 0) return;
    const rect = minimap.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
    const pad = 10;
    const scaleX = (MM_W - pad * 2) / rangeX, scaleY = (MM_H - pad * 2) / rangeY;
    const scale = Math.min(scaleX, scaleY);
    const offX = pad + (MM_W - pad * 2 - rangeX * scale) / 2;
    const offY = pad + (MM_H - pad * 2 - rangeY * scale) / 2;
    const worldX = (cx - offX) / scale + minX;
    const worldY = (cy - offY) / scale + minY;
    animateCameraTo(worldX, worldY, camZoom);
  });

  // ===== Tutorial (feature 1) =====
  const tutorialOverlay = document.getElementById("tutorial-overlay");
  if (!localStorage.getItem("da-tutorial-seen")) {
    tutorialOverlay.style.display = "flex";
  }
  document.getElementById("tutorial-close").addEventListener("click", () => {
    tutorialOverlay.style.display = "none";
    localStorage.setItem("da-tutorial-seen", "1");
  });

  // ===== Animation loop =====
  let mmFrame = 0;
  function loop() {
    simulate(); updatePositions(); draw();
    if (++mmFrame % 3 === 0) drawMinimap();
    requestAnimationFrame(loop);
  }

  // Initial load
  await preloadResearcherNames();

  // Check URL params for initial mode
  const urlMode = new URLSearchParams(window.location.search).get("mode");
  await loadDataset(urlMode && DATASETS[urlMode] ? urlMode : "syllabus");
  applyLang();
  loop();
})();
