(async function () {
  // ===== Data sources =====
  const DATASETS = {
    syllabus: { url: "network_data.json", label: "授業ネットワーク", type: "syllabus" },
    researcher: { url: "researcher_network_data.json", label: "研究業績ネットワーク", type: "researcher" },
  };

  let currentDatasetKey = "syllabus";
  let nodes, edges, idToIndex, edgeIndices, adjacency;
  let instructorMap;
  let clusterColors, clusterCounts, clusterSamples, clusterLabels;
  let N_CLUSTERS;

  // ===== Canvas setup =====
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  let W, H;
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // Camera
  let camX = 0, camY = 0, camZoom = 1;

  // State
  let layoutMode = "umap";
  let layoutTransition = 1;
  let alpha = 0.01;
  let dragging = false, dragStartX, dragStartY, camStartX, camStartY;
  let mouseDownTime = 0;
  let selectedNode = null;
  let hoveredNode = null;
  let activeCluster = null;
  let highlightedNodes = new Set();
  let highlightPulse = 0;
  let suggestionIndex = -1;
  let currentSuggestions = [];

  // ===== Load & init dataset =====
  async function loadDataset(key) {
    const ds = DATASETS[key];
    const res = await fetch(ds.url);
    const data = await res.json();
    currentDatasetKey = key;

    nodes = data.nodes;
    edges = data.edges;

    // Build index
    idToIndex = new Map();
    nodes.forEach((n, i) => {
      idToIndex.set(n.id, i);
      n.umapX = n.x || 0;
      n.umapY = n.y || 0;
      n.forceX = (Math.random() - 0.5) * 800;
      n.forceY = (Math.random() - 0.5) * 800;
      n.vx = 0;
      n.vy = 0;
      n.degree = 0;
    });

    edgeIndices = edges.map((e) => {
      const si = idToIndex.get(e.source);
      const ti = idToIndex.get(e.target);
      if (si !== undefined) nodes[si].degree++;
      if (ti !== undefined) nodes[ti].degree++;
      return { si, ti, weight: e.weight };
    });

    // Adjacency list
    adjacency = new Map();
    edges.forEach((e) => {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      if (!adjacency.has(e.target)) adjacency.set(e.target, []);
      adjacency.get(e.source).push({ id: e.target, weight: e.weight });
      adjacency.get(e.target).push({ id: e.source, weight: e.weight });
    });

    // Cluster colors
    const maxCluster = Math.max(...nodes.map((n) => n.cluster), 0);
    N_CLUSTERS = maxCluster + 1;
    clusterColors = [];
    for (let i = 0; i < N_CLUSTERS; i++) {
      clusterColors.push((i * 360 / N_CLUSTERS + 200) % 360);
    }

    // Predefined topic labels for syllabus clusters
    const SYLLABUS_TOPIC_LABELS = {
      0: "美術史・考古学・歴史資料",
      1: "修士論文指導・研究指導",
      2: "欧米文学・思想テクスト講読",
      3: "言語学・統語論・意味論",
      4: "異文化理解・人文学基礎",
      5: "中央・南・東南アジア地域研究",
      6: "外国語教育・言語習得",
      7: "音楽学・演劇・芸術表現",
      8: "科学技術倫理・学術発表・フランス語",
      9: "研究セミナー・論文執筆",
      10: "美学・美術批評・視覚文化",
      11: "スペイン語・ポルトガル語・イタリア語圏",
      12: "東アジア言語文化・漢籍・朝鮮語学",
      13: "中国文学・語学・中国史",
      14: "フランス語圏文学・文化",
      15: "演劇・社会問題・パフォーマンス",
      16: "西洋古代・中世史・英語圏文学",
      17: "臨床哲学・倫理学・ケア",
      18: "ドイツ・北欧地域研究",
      19: "日本語教育・日本文化研究",
    };

    clusterCounts = new Array(N_CLUSTERS).fill(0);
    clusterSamples = new Array(N_CLUSTERS).fill(null).map(() => []);
    nodes.forEach((n) => {
      const c = n.cluster;
      if (c >= 0 && c < N_CLUSTERS) {
        clusterCounts[c]++;
        if (clusterSamples[c].length < 3) {
          const sample = n.label || "";
          if (sample) clusterSamples[c].push(sample.slice(0, 20));
        }
      }
    });

    if (ds.type === "syllabus") {
      clusterLabels = Array.from({ length: N_CLUSTERS }, (_, i) =>
        SYLLABUS_TOPIC_LABELS[i] || `Topic ${i}`
      );
    } else {
      clusterLabels = clusterSamples.map((samples, i) =>
        samples.length > 0 ? samples.slice(0, 2).join(" / ") : `Topic ${i}`
      );
    }

    // Instructor index (syllabus only)
    instructorMap = new Map();
    if (ds.type === "syllabus") {
      nodes.forEach((n, i) => {
        (n.instructors || []).forEach((name) => {
          const key = name.trim();
          if (!key) return;
          if (!instructorMap.has(key)) instructorMap.set(key, []);
          instructorMap.get(key).push(i);
        });
      });
    }

    // Set positions
    nodes.forEach((n) => {
      n.x = n.umapX;
      n.y = n.umapY;
    });

    // Reset state
    camX = 0; camY = 0; camZoom = 1;
    layoutMode = "umap";
    layoutTransition = 1;
    alpha = 0.01;
    selectedNode = null;
    hoveredNode = null;
    activeCluster = null;
    highlightedNodes = new Set();
    searchInput.value = "";
    suggestions.classList.remove("active");
    hidePanel();
    hideInstructorPanel();
    hideResearcherPanel();

    zoomSlider.value = 1;
    zoomLabel.textContent = "100%";
    toggleBtn.textContent = "UMAP";
    toggleBtn.classList.add("active");

    buildLegend();
    updateModeButtons();
  }

  // ===== Mode switch buttons =====
  const modeBtns = document.querySelectorAll(".mode-btn");
  function updateModeButtons() {
    modeBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === currentDatasetKey);
    });
  }
  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (mode !== currentDatasetKey) {
        loadDataset(mode);
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
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    camZoom = Math.max(0.05, Math.min(3, camZoom * factor));
    zoomSlider.value = camZoom;
    zoomLabel.textContent = Math.round(camZoom * 100) + "%";
  }, { passive: false });

  // ===== Pan & click =====
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    camStartX = camX;
    camStartY = camY;
    mouseDownTime = Date.now();
  });

  canvas.addEventListener("mousemove", (e) => {
    if (dragging) {
      camX = camStartX + (e.clientX - dragStartX) / camZoom;
      camY = camStartY + (e.clientY - dragStartY) / camZoom;
    }
    const mx = (e.clientX - W / 2) / camZoom - camX;
    const my = (e.clientY - H / 2) / camZoom - camY;
    hoveredNode = findNode(mx, my);
    canvas.style.cursor = hoveredNode ? "pointer" : dragging ? "grabbing" : "grab";
  });

  canvas.addEventListener("mouseup", (e) => {
    dragging = false;
    if (Date.now() - mouseDownTime < 250) {
      const mx = (e.clientX - W / 2) / camZoom - camX;
      const my = (e.clientY - H / 2) / camZoom - camY;
      const clicked = findNode(mx, my);
      if (clicked) {
        selectedNode = clicked;
        if (currentDatasetKey === "researcher") {
          showResearcherPanel(clicked);
        } else {
          showPanel(clicked);
        }
      } else {
        selectedNode = null;
        hidePanel();
        hideResearcherPanel();
      }
    }
  });

  function findNode(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = nodeRadius(n);
      const dx = n.x - mx, dy = n.y - my;
      if (dx * dx + dy * dy < (r + 4) * (r + 4)) return n;
    }
    return null;
  }

  function nodeRadius(n) {
    if (currentDatasetKey === "researcher") {
      return 4 + Math.sqrt(n.degree) * 1.5;
    }
    return 3 + Math.sqrt(n.degree) * 1.2;
  }

  // ===== Layout toggle =====
  const toggleBtn = document.getElementById("toggle-layout");
  toggleBtn.classList.add("active");
  toggleBtn.addEventListener("click", () => {
    if (layoutMode === "umap") {
      layoutMode = "force";
      toggleBtn.textContent = "Force";
      toggleBtn.classList.remove("active");
      alpha = 1;
    } else {
      layoutMode = "umap";
      toggleBtn.textContent = "UMAP";
      toggleBtn.classList.add("active");
    }
  });

  // ===== Legend =====
  const legendEl = document.getElementById("legend");
  function buildLegend() {
    let html = '<div class="legend-title">TOPIC CLUSTERS</div>';
    for (let i = 0; i < N_CLUSTERS; i++) {
      if (clusterCounts[i] === 0) continue;
      const hue = clusterColors[i];
      html += `<div class="legend-item" data-cluster="${i}">
        <span class="legend-dot" style="background:hsl(${hue},65%,55%)"></span>
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
    });
  }

  // ===== Search =====
  const searchInput = document.getElementById("search-input");
  const suggestions = document.getElementById("search-suggestions");

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    suggestionIndex = -1;
    if (!q) {
      suggestions.classList.remove("active");
      highlightedNodes.clear();
      return;
    }

    currentSuggestions = [];

    if (currentDatasetKey === "syllabus") {
      // Instructor matches
      for (const [name, indices] of instructorMap) {
        if (name.toLowerCase().includes(q)) {
          currentSuggestions.push({ type: "instructor", name, nodeIndices: indices });
        }
      }
      currentSuggestions.sort((a, b) => b.nodeIndices.length - a.nodeIndices.length);
      currentSuggestions = currentSuggestions.slice(0, 5);

      const courseResults = nodes
        .filter((n) => {
          const label = (n.label || "").toLowerCase();
          const labelEn = (n.label_en || "").toLowerCase();
          const sub = (n.subtitle || "").toLowerCase();
          return label.includes(q) || labelEn.includes(q) || sub.includes(q);
        })
        .slice(0, 15 - currentSuggestions.length)
        .map((n) => ({ type: "node", node: n }));
      currentSuggestions = currentSuggestions.concat(courseResults);
    } else {
      // Researcher mode: search by name, affiliation, top_titles
      const results = nodes
        .filter((n) => {
          const label = (n.label || "").toLowerCase();
          const labelEn = (n.label_en || "").toLowerCase();
          const aff = (n.affiliation || "").toLowerCase();
          const titles = (n.top_titles || []).join(" ").toLowerCase();
          return label.includes(q) || labelEn.includes(q) || aff.includes(q) || titles.includes(q);
        })
        .slice(0, 15)
        .map((n) => ({ type: "node", node: n }));
      currentSuggestions = results;
    }

    renderSuggestions(currentSuggestions, q);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (!suggestions.classList.contains("active")) return;
    const items = suggestions.querySelectorAll("li");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestionIndex = Math.min(suggestionIndex + 1, items.length - 1);
      updateSuggestionHighlight(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestionIndex = Math.max(suggestionIndex - 1, 0);
      updateSuggestionHighlight(items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestionIndex >= 0 && suggestionIndex < currentSuggestions.length) {
        selectSuggestionItem(currentSuggestions[suggestionIndex]);
      } else if (currentSuggestions.length > 0) {
        selectSuggestionItem(currentSuggestions[0]);
      }
    } else if (e.key === "Escape") {
      suggestions.classList.remove("active");
      searchInput.blur();
    }
  });

  function updateSuggestionHighlight(items) {
    items.forEach((li, i) => li.classList.toggle("selected", i === suggestionIndex));
    if (items[suggestionIndex]) items[suggestionIndex].scrollIntoView({ block: "nearest" });
  }

  function renderSuggestions(results, q) {
    if (results.length === 0) {
      suggestions.classList.remove("active");
      return;
    }
    suggestions.innerHTML = results
      .map((item, i) => {
        if (item.type === "instructor") {
          return `<li data-index="${i}" class="suggestion-instructor">
            <div>👤 ${highlightMatch(item.name, q)}</div>
            <div class="suggestion-sub">担当科目 ${item.nodeIndices.length} 件</div>
          </li>`;
        } else {
          const n = item.node;
          if (currentDatasetKey === "researcher") {
            const aff = n.affiliation || "";
            const rank = n.rank || "";
            return `<li data-index="${i}">
              <div>${highlightMatch(n.label, q)}</div>
              <div class="suggestion-sub">${escapeHtml(aff)} ${escapeHtml(rank)} / 業績 ${n.achievement_count || 0} 件</div>
            </li>`;
          } else {
            const instructor = (n.instructors || []).join(", ");
            const sub = n.subtitle ? ` — ${n.subtitle}` : "";
            return `<li data-index="${i}">
              <div>${highlightMatch(n.label, q)}</div>
              <div class="suggestion-sub">${escapeHtml(instructor)}${escapeHtml(sub)}</div>
            </li>`;
          }
        }
      })
      .join("");
    suggestions.classList.add("active");

    suggestions.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        selectSuggestionItem(currentSuggestions[parseInt(li.dataset.index)]);
      });
    });
  }

  function selectSuggestionItem(item) {
    suggestions.classList.remove("active");
    if (item.type === "instructor") {
      selectInstructor(item.name, item.nodeIndices);
    } else {
      selectSearchResult(item.node);
    }
  }

  function selectInstructor(name, nodeIndices) {
    highlightedNodes = new Set(nodeIndices.map((i) => nodes[i].id));
    highlightPulse = 0;
    searchInput.value = name;
    selectedNode = null;
    hidePanel();
    showInstructorPanel(name, nodeIndices);

    if (nodeIndices.length > 0) {
      let cx = 0, cy = 0;
      nodeIndices.forEach((i) => { cx += nodes[i].x; cy += nodes[i].y; });
      cx /= nodeIndices.length;
      cy /= nodeIndices.length;
      animateCameraTo(cx, cy, nodeIndices.length > 5 ? 0.6 : 0.9);
    }
  }

  function selectSearchResult(n) {
    highlightedNodes = new Set([n.id]);
    highlightPulse = 0;
    selectedNode = n;
    hideInstructorPanel();
    suggestions.classList.remove("active");
    searchInput.value = n.label;

    if (currentDatasetKey === "researcher") {
      showResearcherPanel(n);
      hidePanel();
    } else {
      showPanel(n);
      hideResearcherPanel();
    }
    animateCameraTo(n.x, n.y, 1.2);
  }

  function highlightMatch(text, q) {
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, idx)) +
      `<strong style="color:#b8a0ff">${escapeHtml(text.slice(idx, idx + q.length))}</strong>` +
      escapeHtml(text.slice(idx + q.length))
    );
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function animateCameraTo(tx, ty, tz) {
    const startX = camX, startY = camY, startZ = camZoom;
    const targetX = -tx, targetY = -ty, targetZ = tz;
    const duration = 600;
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      camX = startX + (targetX - startX) * ease;
      camY = startY + (targetY - startY) * ease;
      camZoom = startZ + (targetZ - startZ) * ease;
      zoomSlider.value = camZoom;
      zoomLabel.textContent = Math.round(camZoom * 100) + "%";
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-box")) suggestions.classList.remove("active");
  });

  // ===== Syllabus Info panel =====
  const panel = document.getElementById("info-panel");
  const panelTitle = document.getElementById("panel-title");
  const panelTitleEn = document.getElementById("panel-title-en");
  const panelSubtitle = document.getElementById("panel-subtitle");
  const panelSemester = document.getElementById("panel-semester");
  const panelDay = document.getElementById("panel-day");
  const panelCluster = document.getElementById("panel-cluster");
  const panelInstructors = document.getElementById("panel-instructors");
  const panelObjective = document.getElementById("panel-objective");
  const panelGoals = document.getElementById("panel-goals");
  const panelRelated = document.getElementById("panel-related");

  document.getElementById("panel-close").addEventListener("click", () => {
    selectedNode = null;
    hidePanel();
  });

  function showPanel(n) {
    panelTitle.textContent = n.label;
    panelTitleEn.textContent = n.label_en || "";
    panelSubtitle.textContent = n.subtitle || "";
    panelSemester.textContent = n.semester || "";
    panelDay.textContent = n.day_period || "";
    panelCluster.textContent = `Topic ${n.cluster}`;
    panelCluster.style.borderColor = `hsl(${clusterColors[n.cluster]}, 60%, 50%)`;
    panelCluster.style.color = `hsl(${clusterColors[n.cluster]}, 70%, 65%)`;
    panelInstructors.innerHTML = (n.instructors || [])
      .map((name) => `<span class="instructor-chip clickable" data-instructor="${escapeHtml(name)}">${escapeHtml(name)}</span>`)
      .join("");
    panelInstructors.querySelectorAll(".instructor-chip.clickable").forEach((chip) => {
      chip.addEventListener("click", () => {
        const instrName = chip.dataset.instructor;
        const indices = instructorMap.get(instrName);
        if (indices) {
          hidePanel();
          selectInstructor(instrName, indices);
        }
      });
    });
    panelObjective.textContent = n.objective || "（情報なし）";
    panelGoals.textContent = n.goals || "（情報なし）";

    const related = (adjacency.get(n.id) || [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);
    panelRelated.innerHTML = related
      .map((r) => {
        const rNode = nodes[idToIndex.get(r.id)];
        if (!rNode) return "";
        const name = rNode.label.replace(/^\[科目\]/, "");
        return `<li data-id="${r.id}">${escapeHtml(name)}<span class="rel-score">${Math.round(r.weight * 100)}%</span></li>`;
      })
      .join("");

    panelRelated.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const rn = nodes[idToIndex.get(li.dataset.id)];
        if (rn) {
          selectedNode = rn;
          showPanel(rn);
          animateCameraTo(rn.x, rn.y, 1.2);
          highlightedNodes = new Set([rn.id]);
          highlightPulse = 0;
        }
      });
    });

    panel.classList.remove("hidden");
  }

  function hidePanel() {
    panel.classList.add("hidden");
  }

  // ===== Instructor panel =====
  const instrPanel = document.getElementById("instructor-panel");
  const instrPanelName = document.getElementById("instr-panel-name");
  const instrPanelCount = document.getElementById("instr-panel-count");
  const instrPanelList = document.getElementById("instr-panel-list");

  document.getElementById("instr-panel-close").addEventListener("click", () => {
    hideInstructorPanel();
    highlightedNodes.clear();
  });

  function showInstructorPanel(name, nodeIndices) {
    instrPanelName.textContent = name;
    instrPanelCount.textContent = `${nodeIndices.length} 科目`;

    instrPanelList.innerHTML = nodeIndices
      .map((i) => {
        const n = nodes[i];
        const courseName = n.label.replace(/^\[科目\]/, "");
        const sub = n.subtitle ? ` — ${n.subtitle}` : "";
        return `<li data-id="${n.id}">
          <div class="instr-course-name">${escapeHtml(courseName)}</div>
          <div class="instr-course-sub">${escapeHtml(n.semester || "")}${escapeHtml(sub)}</div>
        </li>`;
      })
      .join("");

    instrPanelList.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const n = nodes[idToIndex.get(li.dataset.id)];
        if (n) {
          hideInstructorPanel();
          selectedNode = n;
          highlightedNodes = new Set([n.id]);
          highlightPulse = 0;
          showPanel(n);
          animateCameraTo(n.x, n.y, 1.2);
        }
      });
    });

    instrPanel.classList.remove("hidden");
  }

  function hideInstructorPanel() {
    instrPanel.classList.add("hidden");
  }

  // ===== Researcher panel =====
  const resPanel = document.getElementById("researcher-panel");
  const resPanelName = document.getElementById("res-panel-name");
  const resPanelNameEn = document.getElementById("res-panel-name-en");
  const resPanelAff = document.getElementById("res-panel-affiliation");
  const resPanelRank = document.getElementById("res-panel-rank");
  const resPanelCluster = document.getElementById("res-panel-cluster");
  const resPanelCount = document.getElementById("res-panel-count");
  const resPanelTitles = document.getElementById("res-panel-titles");
  const resPanelRelated = document.getElementById("res-panel-related");

  document.getElementById("res-panel-close").addEventListener("click", () => {
    selectedNode = null;
    hideResearcherPanel();
  });

  function showResearcherPanel(n) {
    resPanelName.textContent = n.label;
    resPanelNameEn.textContent = n.label_en || "";
    resPanelAff.textContent = n.affiliation || "";
    resPanelRank.textContent = n.rank || "";
    resPanelCluster.textContent = `Topic ${n.cluster}`;
    resPanelCluster.style.borderColor = `hsl(${clusterColors[n.cluster]}, 60%, 50%)`;
    resPanelCluster.style.color = `hsl(${clusterColors[n.cluster]}, 70%, 65%)`;
    resPanelCount.textContent = `${n.achievement_count || 0} 件`;

    resPanelTitles.innerHTML = (n.top_titles || [])
      .map((t) => `<li>${escapeHtml(t)}</li>`)
      .join("");

    const related = (adjacency.get(n.id) || [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);
    resPanelRelated.innerHTML = related
      .map((r) => {
        const rNode = nodes[idToIndex.get(r.id)];
        if (!rNode) return "";
        return `<li data-id="${r.id}">${escapeHtml(rNode.label)}<span class="rel-score">${Math.round(r.weight * 100)}%</span></li>`;
      })
      .join("");

    resPanelRelated.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", () => {
        const rn = nodes[idToIndex.get(li.dataset.id)];
        if (rn) {
          selectedNode = rn;
          showResearcherPanel(rn);
          animateCameraTo(rn.x, rn.y, 1.2);
          highlightedNodes = new Set([rn.id]);
          highlightPulse = 0;
        }
      });
    });

    resPanel.classList.remove("hidden");
  }

  function hideResearcherPanel() {
    resPanel.classList.add("hidden");
  }

  // ===== Force simulation =====
  function simulate() {
    if (layoutMode !== "force" || alpha < 0.001) return;

    const n = nodes.length;
    const repK = 800;
    const sampleCount = Math.min(n * 8, n * (n - 1) / 2);
    for (let s = 0; s < sampleCount; s++) {
      const i = Math.floor(Math.random() * n);
      const j = Math.floor(Math.random() * n);
      if (i === j) continue;
      const a = nodes[i], b = nodes[j];
      let dx = a.forceX - b.forceX, dy = a.forceY - b.forceY;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      const f = (alpha * repK) / d2;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }

    const attK = 0.005;
    for (const e of edgeIndices) {
      if (e.si === undefined || e.ti === undefined) continue;
      const a = nodes[e.si], b = nodes[e.ti];
      const dx = b.forceX - a.forceX, dy = b.forceY - a.forceY;
      const f = alpha * attK * e.weight;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }

    for (const nd of nodes) {
      nd.vx -= nd.forceX * alpha * 0.001;
      nd.vy -= nd.forceY * alpha * 0.001;
      nd.vx *= 0.6; nd.vy *= 0.6;
      nd.forceX += nd.vx;
      nd.forceY += nd.vy;
    }
    alpha *= 0.997;
  }

  function updatePositions() {
    const targetT = layoutMode === "umap" ? 1.0 : 0.0;
    layoutTransition += (targetT - layoutTransition) * 0.08;
    for (const n of nodes) {
      n.x = n.forceX * (1 - layoutTransition) + n.umapX * layoutTransition;
      n.y = n.forceY * (1 - layoutTransition) + n.umapY * layoutTransition;
    }
  }

  // ===== Drawing =====
  function getNodeColor(n, isActive) {
    const hue = clusterColors[n.cluster] || 200;
    if (isActive) return `hsla(${hue}, 80%, 70%, 0.95)`;
    return `hsla(${hue}, 65%, 55%, 0.85)`;
  }

  function getGlowColor(n) {
    const hue = clusterColors[n.cluster] || 200;
    return `hsla(${hue}, 80%, 60%, 0.35)`;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(camZoom, camZoom);
    ctx.translate(camX, camY);

    highlightPulse += 0.04;

    const clusterDim = activeCluster !== null;

    // Edges
    for (const e of edgeIndices) {
      if (e.si === undefined || e.ti === undefined) continue;
      const a = nodes[e.si], b = nodes[e.ti];
      if (clusterDim && a.cluster !== activeCluster && b.cluster !== activeCluster) continue;

      const isSelected = selectedNode && (a.id === selectedNode.id || b.id === selectedNode.id);
      const isSearchHit = highlightedNodes.size > 0 && (highlightedNodes.has(a.id) || highlightedNodes.has(b.id));

      if (isSelected || isSearchHit) {
        ctx.strokeStyle = `rgba(160, 120, 255, ${0.3 + e.weight * 0.5})`;
        ctx.lineWidth = 1.5;
      } else {
        const dimFactor = clusterDim ? 0.03 : 1;
        ctx.strokeStyle = `rgba(80, 60, 140, ${(0.05 + e.weight * 0.08) * dimFactor})`;
        ctx.lineWidth = 0.5;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Nodes
    const active = hoveredNode || selectedNode;
    for (const n of nodes) {
      const r = nodeRadius(n);
      const isActive = active && n.id === active.id;
      const isSearchHit = highlightedNodes.has(n.id);
      const isDimmed = clusterDim && n.cluster !== activeCluster && !isActive && !isSearchHit;

      if (isSearchHit) {
        const pulse = 0.5 + 0.5 * Math.sin(highlightPulse);
        const glowR = r * (5 + pulse * 4);
        const grad = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, glowR);
        grad.addColorStop(0, `hsla(45, 100%, 70%, ${0.5 + pulse * 0.3})`);
        grad.addColorStop(0.5, `hsla(45, 100%, 60%, ${0.15 + pulse * 0.1})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `hsla(45, 100%, 75%, 0.95)`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 1.5, 0, Math.PI * 2);
        ctx.fill();

        // Show name label on highlighted researcher nodes
        if (currentDatasetKey === "researcher") {
          ctx.fillStyle = `rgba(255, 255, 255, 0.9)`;
          ctx.font = `bold 11px "Hiragino Sans", sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x, n.y - r * 1.5 - 6);
        }
        continue;
      }

      if (isDimmed) {
        ctx.fillStyle = `rgba(60, 55, 80, 0.25)`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      if (isActive || n.degree > 5) {
        const grad = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, r * (isActive ? 5 : 3));
        grad.addColorStop(0, getGlowColor(n));
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * (isActive ? 5 : 3), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = getNodeColor(n, isActive);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Labels
      if (currentDatasetKey === "researcher") {
        // Always show researcher names at sufficient zoom
        if (camZoom > 0.6 || isActive) {
          const opacity = isActive ? 0.95 : Math.min(0.75, (camZoom - 0.4) * 1.5);
          if (opacity > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
            const fontSize = Math.max(7, Math.min(11, 9 / Math.sqrt(camZoom)));
            ctx.font = `${fontSize}px "Hiragino Sans", sans-serif`;
            ctx.textAlign = "center";
            ctx.fillText(n.label, n.x, n.y - r - 4);
          }
        }
      } else {
        if (camZoom > 1.0 && n.degree > 10) {
          const label = (n.subtitle || n.label || "").replace(/^\[科目\]/, "").slice(0, 15);
          ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.8, (camZoom - 1) * 0.8)})`;
          ctx.font = `${Math.max(8, 10 / camZoom * 1.2)}px "Hiragino Sans", sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(label, n.x, n.y - r - 4);
        }
      }
    }

    ctx.restore();
  }

  // Animation loop
  function loop() {
    simulate();
    updatePositions();
    draw();
    requestAnimationFrame(loop);
  }

  // Initial load
  await loadDataset("syllabus");
  loop();
})();
