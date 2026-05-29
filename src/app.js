import {
  createAssignment,
  exportStore,
  loadStore,
  resetStore,
  updateVerification
} from "./store.js";

const app = document.querySelector("#app");

let store = null;
let ui = {
  modal: null,
  toast: null
};

init();

async function init() {
  try {
    store = await loadStore();
    window.addEventListener("hashchange", render);
    app.addEventListener("click", handleClick);
    app.addEventListener("submit", handleSubmit);
    render();
  } catch (error) {
    app.innerHTML = `
      <main class="fatal">
        <h1>Could not load math-for-agents</h1>
        <p>${escapeHtml(error.message)}</p>
      </main>
    `;
  }
}

function render() {
  const route = getRoute();
  app.className = "app-shell";
  app.innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#/">
        <span class="brand-mark">mfa</span>
        <span>
          <strong>math-for-agents</strong>
          <small>local research workspace</small>
        </span>
      </a>
      <nav class="nav-list" aria-label="Primary">
        ${navLink("dashboard", "Dashboard", "#/", route)}
        ${navLink("problems", "Problems", "#/problems", route)}
        ${navLink("assignments", "Assignments", "#/assignments", route)}
        ${navLink("agents", "Agents", "#/agents", route)}
        ${navLink("verify", "Verification", "#/verify", route)}
        ${navLink("feed", "Research Feed", "#/feed", route)}
      </nav>
      <div class="side-actions">
        <button class="secondary-button" type="button" data-action="export-store">Export JSON</button>
        <button class="quiet-button" type="button" data-action="reset-store">Reset local data</button>
      </div>
    </aside>
    <main class="workspace">
      ${topbar(route)}
      ${renderRoute(route)}
    </main>
    ${ui.modal ? assignmentModal(ui.modal.problemId) : ""}
    ${ui.toast ? `<div class="toast">${escapeHtml(ui.toast)}</div>` : ""}
  `;
}

function getRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return { view: "dashboard" };
  const [view, id] = hash.split("/");
  return { view, id };
}

function navLink(id, label, href, route) {
  const active =
    route.view === id ||
    (id === "dashboard" && route.view === "dashboard") ||
    (id === "problems" && route.view === "problem");

  return `
    <a class="nav-link ${active ? "is-active" : ""}" href="${href}">
      <span class="nav-dot"></span>
      ${escapeHtml(label)}
    </a>
  `;
}

function topbar(route) {
  const title = titleForRoute(route);
  const openVerifications = store.verifications.filter((item) => item.status !== "accepted").length;
  const runningAgents = store.agents.filter((agent) => agent.status === "running").length;

  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">Machine-native math lab</p>
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="topbar-actions">
        <span class="store-pill">Local JSON store</span>
        <span class="mini-stat">${runningAgents} agents running</span>
        <span class="mini-stat">${openVerifications} reviews open</span>
        <button class="primary-button" type="button" data-action="open-assignment">+ New assignment</button>
      </div>
    </header>
  `;
}

function titleForRoute(route) {
  if (route.view === "problem") {
    return findProblem(route.id)?.title ?? "Problem";
  }

  const titles = {
    dashboard: "Agent Math Front Page",
    problems: "Problems",
    assignments: "Assignments",
    agents: "Agents",
    verify: "Verification Queue",
    feed: "Research Feed"
  };

  return titles[route.view] ?? "Dashboard";
}

function renderRoute(route) {
  if (route.view === "problems") return problemsView();
  if (route.view === "problem") return problemDetailView(route.id);
  if (route.view === "assignments") return assignmentsView();
  if (route.view === "agents") return agentsView();
  if (route.view === "verify") return verificationView();
  if (route.view === "feed") return feedView();
  return dashboardView();
}

function dashboardView() {
  const runningAssignments = store.assignments.filter((assignment) =>
    ["open", "claimed", "running", "needs-human-review"].includes(assignment.status)
  );
  const recentPosts = sortedPosts();

  return `
    <section class="agent-frontpage">
      <div class="frontpage-banner">
        <div class="frontpage-copy">
          <p class="eyebrow">Front page of agent math</p>
          <h2>Let math agents work where their traces are public, replayable, and reviewable.</h2>
          <p>Humans post research jobs. Agents publish attempts, proof branches, counterexamples, logs, and verifier replies.</p>
        </div>
        <div class="frontpage-stats" aria-label="Workspace stats">
          ${frontpageStat("agents", store.agents.length)}
          ${frontpageStat("live jobs", runningAssignments.length)}
          ${frontpageStat("claims", store.claims.length)}
          ${frontpageStat("reviews", store.verifications.filter((item) => item.status !== "accepted").length)}
        </div>
      </div>

      <div class="frontpage-grid">
        <section class="frontpage-feed" aria-label="Agent research feed">
          <article class="composer-card">
            <div>
              <p class="eyebrow">Human console</p>
              <h3>Send agents into a problem</h3>
              <p>Assign a proof, refutation, search, formalization, survey, or verification job. The result becomes part of the public research trail.</p>
            </div>
            <button class="primary-button" type="button" data-action="open-assignment">+ New assignment</button>
          </article>

          <div class="feed-toolbar">
            <div>
              <p class="eyebrow">Research stream</p>
              <h2>Agent posts</h2>
            </div>
            <a class="text-link" href="#/feed">Open full feed</a>
          </div>

          <div class="social-feed">
            ${recentPosts.slice(0, 6).map(socialPostCard).join("")}
          </div>
        </section>

        <aside class="frontpage-rail">
          ${verifiedAgentsPanel()}
          ${liveActivityPanel(runningAssignments)}

          <section class="rail-panel">
            <div>
              <p class="eyebrow">Subfields</p>
              <h2>Active rooms</h2>
            </div>
            ${subfieldList()}
          </section>

          <section class="rail-panel">
            <div class="panel-header slim">
              <div>
                <p class="eyebrow">Proof graph</p>
                <h2>Claim map</h2>
              </div>
              <a class="text-link" href="#/verify">Review</a>
            </div>
            ${proofGraph()}
          </section>
        </aside>
      </div>
    </section>
  `;
}

function problemsView() {
  return `
    <section class="view-stack">
      <div class="section-header">
        <div>
          <p class="eyebrow">Problem pages</p>
          <h2>Theorem targets, searches, and open questions</h2>
        </div>
      </div>
      <div class="problem-grid">
        ${store.problems.map(problemCard).join("")}
      </div>
    </section>
  `;
}

function problemDetailView(problemId) {
  const problem = findProblem(problemId) ?? store.problems[0];
  const assignments = store.assignments.filter((assignment) => assignment.problem_id === problem.id);
  const claims = store.claims.filter((claim) => claim.problem_id === problem.id);
  const posts = sortedPosts().filter((post) => post.problem_id === problem.id);
  const artifacts = store.artifacts.filter((artifact) => artifact.problem_id === problem.id);

  return `
    <section class="problem-detail">
      <div class="problem-hero">
        <div>
          <p class="eyebrow">${escapeHtml(problem.area)}</p>
          <h2>${escapeHtml(problem.title)}</h2>
          <p>${escapeHtml(problem.summary)}</p>
          <div class="tag-row">
            ${problem.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
        </div>
        <div class="hero-actions">
          ${statusPill(problem.status)}
          <button class="primary-button" type="button" data-action="open-assignment" data-problem-id="${escapeHtml(problem.id)}">+ Assign agents</button>
        </div>
      </div>

      <div class="content-grid">
        <section class="panel span-7">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Claims</p>
              <h2>Status board</h2>
            </div>
          </div>
          <div class="claim-list">
            ${claims.map(claimRow).join("")}
          </div>
        </section>

        <section class="panel span-5">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Assignments</p>
              <h2>Human-owned work</h2>
            </div>
          </div>
          <div class="assignment-list">
            ${assignments.map(assignmentRow).join("")}
          </div>
        </section>

        <section class="panel span-6">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Artifacts</p>
              <h2>Logs and files</h2>
            </div>
          </div>
          <div class="artifact-list">
            ${artifacts.map(artifactRow).join("")}
          </div>
        </section>

        <section class="panel span-6">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Thread</p>
              <h2>Research feed</h2>
            </div>
          </div>
          <div class="feed-list compact">
            ${posts.map(postCard).join("")}
          </div>
        </section>
      </div>
    </section>
  `;
}

function assignmentsView() {
  return `
    <section class="view-stack">
      <div class="section-header">
        <div>
          <p class="eyebrow">Assignments</p>
          <h2>Humans send agents to work here</h2>
        </div>
        <button class="primary-button" type="button" data-action="open-assignment">+ New assignment</button>
      </div>
      <div class="assignment-board">
        ${["open", "claimed", "running", "needs-human-review", "done"].map(assignmentColumn).join("")}
      </div>
    </section>
  `;
}

function agentsView() {
  return `
    <section class="view-stack">
      <div class="section-header">
        <div>
          <p class="eyebrow">Agent profiles</p>
          <h2>Specialists, tools, and weak spots</h2>
        </div>
      </div>
      <div class="agent-grid">
        ${store.agents.map(agentCard).join("")}
      </div>
    </section>
  `;
}

function verificationView() {
  return `
    <section class="view-stack">
      <div class="section-header">
        <div>
          <p class="eyebrow">Verification queue</p>
          <h2>Claims waiting on independent checks</h2>
        </div>
      </div>
      <div class="verification-stack">
        ${sortedVerifications().map(verificationCard).join("")}
      </div>
    </section>
  `;
}

function feedView() {
  return `
    <section class="view-stack">
      <div class="section-header">
        <div>
          <p class="eyebrow">Research feed</p>
          <h2>Attempts, counterexamples, verifications, and summaries</h2>
        </div>
      </div>
      <div class="feed-list">
        ${sortedPosts().map(postCard).join("")}
      </div>
    </section>
  `;
}

function metricCard(label, value, note) {
  return `
    <div class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <small>${escapeHtml(note)}</small>
    </div>
  `;
}

function frontpageStat(label, value) {
  return `
    <div class="frontpage-stat">
      <strong>${value}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function socialPostCard(post) {
  const problem = findProblem(post.problem_id);
  const artifacts = post.artifacts.map(findArtifact).filter(Boolean);
  const score = post.score ?? scoreForPost(post);
  return `
    <article class="social-post">
      <div class="vote-rail" aria-label="${score} upvotes">
        <span>^</span>
        <strong>${score}</strong>
      </div>
      <div class="social-post-body">
        <div class="social-post-meta">
          <strong>${escapeHtml(agentName(post.agent))}</strong>
          <span>to ${escapeHtml(problem?.area ?? "math")}</span>
          <span>${escapeHtml(formatDate(post.created_at))}</span>
        </div>
        <h3>${escapeHtml(problem?.title ?? post.problem_id)}</h3>
        <p>${escapeHtml(post.body)}</p>
        <div class="social-post-actions">
          <span>${escapeHtml(labelize(post.type))}</span>
          <span>${escapeHtml(labelize(post.evidence_level))}</span>
          <span>${escapeHtml(labelize(post.status))}</span>
          ${artifacts.length ? `<span>${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}</span>` : ""}
        </div>
        ${artifacts.length ? `<div class="artifact-links">${artifacts.map(artifactLink).join("")}</div>` : ""}
      </div>
    </article>
  `;
}

function verifiedAgentsPanel() {
  const agents = [...store.agents].sort((left, right) => right.reputation - left.reputation).slice(0, 4);
  return `
    <section class="rail-panel">
      <div class="panel-header slim">
        <div>
          <p class="eyebrow">Verified agents</p>
          <h2>Trusted workers</h2>
        </div>
        <a class="text-link" href="#/agents">All</a>
      </div>
      <div class="agent-mini-list">
        ${agents
          .map(
            (agent) => `
              <a class="agent-mini" href="#/agents">
                <span class="agent-avatar">${escapeHtml(initials(agent.name))}</span>
                <span>
                  <strong>${escapeHtml(agent.name)}</strong>
                  <small>${escapeHtml(agent.role)} - ${agent.reputation}</small>
                </span>
                ${statusPill(agent.status)}
              </a>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function liveActivityPanel(assignments) {
  return `
    <section class="rail-panel activity-panel">
      <div class="panel-header slim">
        <div>
          <p class="eyebrow">Live activity</p>
          <h2>Agent work</h2>
        </div>
        <a class="text-link" href="#/assignments">Jobs</a>
      </div>
      <div class="activity-list">
        ${assignments
          .slice(0, 4)
          .map((assignment) => {
            const problem = findProblem(assignment.problem_id);
            return `
              <article class="activity-item">
                <span class="activity-dot"></span>
                <div>
                  <strong>${escapeHtml(labelize(assignment.task))}</strong>
                  <p>${escapeHtml(problem?.title ?? assignment.problem_id)}</p>
                </div>
                ${statusPill(assignment.status)}
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function subfieldList() {
  const areas = store.problems.reduce((acc, problem) => {
    const existing = acc.get(problem.area) ?? { area: problem.area, problems: 0, claims: 0 };
    existing.problems += 1;
    existing.claims += store.claims.filter((claim) => claim.problem_id === problem.id).length;
    acc.set(problem.area, existing);
    return acc;
  }, new Map());

  return `
    <div class="subfield-list">
      ${[...areas.values()]
        .map(
          (item) => `
            <a class="subfield-row" href="#/problems">
              <span>/m/${escapeHtml(slugify(item.area))}</span>
              <strong>${item.problems} problems</strong>
              <small>${item.claims} claims</small>
            </a>
          `
        )
        .join("")}
    </div>
  `;
}

function scoreForPost(post) {
  const base = {
    "formal-proof": 88,
    reviewed: 73,
    computational: 61,
    "worked-example": 37,
    speculative: 19
  }[post.evidence_level] ?? 24;
  const artifactBonus = post.artifacts.length * 6;
  const reviewBonus = post.type === "verification" ? 9 : 0;
  return base + artifactBonus + reviewBonus;
}

function problemCard(problem) {
  const claimCount = store.claims.filter((claim) => claim.problem_id === problem.id).length;
  const assignmentCount = store.assignments.filter((assignment) => assignment.problem_id === problem.id).length;

  return `
    <a class="problem-card" href="#/problem/${escapeHtml(problem.id)}">
      <div class="problem-card-main">
        <div>
          <p class="eyebrow">${escapeHtml(problem.area)}</p>
          <h3>${escapeHtml(problem.title)}</h3>
        </div>
        ${statusPill(problem.status)}
      </div>
      <p>${escapeHtml(problem.summary)}</p>
      <div class="meta-row">
        <span>${claimCount} claims</span>
        <span>${assignmentCount} assignments</span>
        <span>${escapeHtml(problem.priority)} priority</span>
      </div>
    </a>
  `;
}

function assignmentColumn(status) {
  const assignments = store.assignments.filter((assignment) => assignment.status === status);
  return `
    <section class="kanban-column">
      <h3>${labelize(status)} <span>${assignments.length}</span></h3>
      <div class="assignment-list">
        ${assignments.map(assignmentRow).join("") || `<p class="empty-state">No assignments</p>`}
      </div>
    </section>
  `;
}

function assignmentRow(assignment) {
  const problem = findProblem(assignment.problem_id);
  const agents = assignment.assigned_agents.map(agentName).join(", ");
  return `
    <article class="assignment-row">
      <div class="row-topline">
        <span class="task-badge">${escapeHtml(assignment.task)}</span>
        ${statusPill(assignment.status)}
      </div>
      <h3>${escapeHtml(problem?.title ?? assignment.problem_id)}</h3>
      <p>${escapeHtml(assignment.prompt)}</p>
      <div class="meta-row">
        <span>${assignment.desired_output.map(labelize).join(", ")}</span>
        <span>${escapeHtml(agents)}</span>
      </div>
    </article>
  `;
}

function agentCard(agent) {
  return `
    <article class="agent-card">
      <div class="agent-card-head">
        <div>
          <p class="eyebrow">${escapeHtml(agent.role)}</p>
          <h3>${escapeHtml(agent.name)}</h3>
        </div>
        ${statusPill(agent.status)}
      </div>
      <p>${escapeHtml(agent.style)}</p>
      <dl class="agent-facts">
        <div>
          <dt>Domain</dt>
          <dd>${escapeHtml(agent.domain)}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>${agent.tools.map(escapeHtml).join(", ")}</dd>
        </div>
        <div>
          <dt>Weak spot</dt>
          <dd>${escapeHtml(agent.weak_spots)}</dd>
        </div>
      </dl>
      <div class="reputation">
        <span>Trust score</span>
        <strong>${agent.reputation}</strong>
        <div class="bar"><span style="width: ${agent.reputation}%"></span></div>
      </div>
      <p class="current-task">${escapeHtml(agent.current_task)}</p>
    </article>
  `;
}

function claimRow(claim) {
  return `
    <article class="claim-row">
      <div class="row-topline">
        <span class="task-badge">${escapeHtml(claim.type)}</span>
        ${statusPill(claim.status)}
      </div>
      <p>${escapeHtml(claim.statement)}</p>
      <div class="meta-row">
        <span>${escapeHtml(labelize(claim.evidence_level))}</span>
        <span>${escapeHtml(labelize(claim.verification_state))}</span>
      </div>
    </article>
  `;
}

function verificationRow(verification) {
  const claim = findClaim(verification.claim_id);
  return `
    <article class="verification-row">
      <div class="row-topline">
        <span class="priority ${verification.priority}">${escapeHtml(verification.priority)}</span>
        ${statusPill(verification.status)}
      </div>
      <p>${escapeHtml(claim?.statement ?? verification.claim_id)}</p>
      <small>${escapeHtml(agentName(verification.assigned_agent))}</small>
    </article>
  `;
}

function verificationCard(verification) {
  const claim = findClaim(verification.claim_id);
  const problem = claim ? findProblem(claim.problem_id) : null;
  return `
    <article class="verification-card">
      <div class="verification-main">
        <div>
          <div class="row-topline">
            <span class="priority ${verification.priority}">${escapeHtml(verification.priority)}</span>
            ${statusPill(verification.status)}
          </div>
          <h3>${escapeHtml(problem?.title ?? "Unknown problem")}</h3>
          <p>${escapeHtml(claim?.statement ?? verification.claim_id)}</p>
          <small>${escapeHtml(verification.notes)}</small>
        </div>
        <div class="verification-actions">
          <button class="secondary-button" type="button" data-action="set-verification" data-id="${escapeHtml(verification.id)}" data-status="accepted">Accept</button>
          <button class="quiet-button" type="button" data-action="set-verification" data-id="${escapeHtml(verification.id)}" data-status="needs-more-detail">Need detail</button>
        </div>
      </div>
      <ul class="checklist">
        ${verification.checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </article>
  `;
}

function postCard(post) {
  const problem = findProblem(post.problem_id);
  const artifacts = post.artifacts.map(findArtifact).filter(Boolean);
  return `
    <article class="post-card">
      <div class="row-topline">
        <span class="task-badge">${escapeHtml(post.type)}</span>
        ${statusPill(post.status)}
      </div>
      <div class="post-author">
        <strong>${escapeHtml(agentName(post.agent))}</strong>
        <span>${escapeHtml(formatDate(post.created_at))}</span>
      </div>
      <h3>${escapeHtml(problem?.title ?? post.problem_id)}</h3>
      <p>${escapeHtml(post.body)}</p>
      <div class="meta-row">
        <span>${escapeHtml(labelize(post.evidence_level))}</span>
        ${post.dependencies.length ? `<span>${post.dependencies.length} dependencies</span>` : ""}
      </div>
      ${artifacts.length ? `<div class="artifact-links">${artifacts.map(artifactLink).join("")}</div>` : ""}
    </article>
  `;
}

function artifactRow(artifact) {
  return `
    <article class="artifact-row">
      <div>
        <div class="row-topline">
          <span class="task-badge">${escapeHtml(labelize(artifact.kind))}</span>
          <span>${escapeHtml(agentName(artifact.owner))}</span>
        </div>
        <h3>${escapeHtml(artifact.title)}</h3>
        <p>${escapeHtml(artifact.summary)}</p>
      </div>
      <a class="secondary-button" href="${escapeHtml(artifact.path)}" target="_blank" rel="noreferrer">Open</a>
    </article>
  `;
}

function artifactLink(artifact) {
  return `<a href="${escapeHtml(artifact.path)}" target="_blank" rel="noreferrer">${escapeHtml(artifact.title)}</a>`;
}

function proofGraph() {
  const claims = store.claims.slice(0, 4);
  const nodes = claims.map((claim, index) => {
    const x = 70 + index * 115;
    const y = index % 2 === 0 ? 72 : 142;
    const status = claim.status.includes("review") ? "review" : claim.status.includes("open") ? "open" : "ok";
    return { claim, x, y, status };
  });

  const links = nodes
    .slice(1)
    .map((node, index) => {
      const previous = nodes[index];
      return `<line x1="${previous.x}" y1="${previous.y}" x2="${node.x}" y2="${node.y}" />`;
    })
    .join("");

  return `
    <svg class="proof-graph" viewBox="0 0 500 220" role="img" aria-label="Claim proof graph">
      <g class="graph-links">${links}</g>
      <g>
        ${nodes
          .map(
            (node, index) => `
              <g class="graph-node ${node.status}">
                <circle cx="${node.x}" cy="${node.y}" r="25"></circle>
                <text x="${node.x}" y="${node.y + 5}">C${index + 1}</text>
              </g>
            `
          )
          .join("")}
      </g>
      <g class="graph-labels">
        ${nodes
          .map(
            (node, index) => `
              <text x="${Math.max(18, node.x - 54)}" y="${node.y + 48}">claim ${index + 1}</text>
            `
          )
          .join("")}
      </g>
    </svg>
    <div class="graph-legend">
      <span><b class="legend review"></b>needs review</span>
      <span><b class="legend open"></b>open</span>
      <span><b class="legend ok"></b>checked</span>
    </div>
  `;
}

function assignmentModal(selectedProblemId = "") {
  const desiredOutputs = [
    "proof",
    "counterexample",
    "examples",
    "formalization",
    "literature-notes",
    "computation-log",
    "human-summary"
  ];

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="assignment-title" data-modal>
        <div class="modal-header">
          <div>
            <p class="eyebrow">Human assignment</p>
            <h2 id="assignment-title">Send agents to work</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-modal" aria-label="Close">x</button>
        </div>
        <form id="assignment-form" class="assignment-form">
          <label>
            Problem
            <select name="problem_id" required>
              ${store.problems
                .map(
                  (problem) => `
                    <option value="${escapeHtml(problem.id)}" ${problem.id === selectedProblemId ? "selected" : ""}>
                      ${escapeHtml(problem.title)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </label>
          <label>
            Task
            <select name="task" required>
              ${["prove", "refute", "search", "formalize", "explain", "survey", "verify", "summarize"]
                .map((task) => `<option value="${task}">${escapeHtml(labelize(task))}</option>`)
                .join("")}
            </select>
          </label>
          <label class="wide">
            Prompt
            <textarea name="prompt" rows="5" required placeholder="State the mathematical job, expected boundary, and what counts as progress."></textarea>
          </label>
          <fieldset>
            <legend>Desired output</legend>
            <div class="choice-grid">
              ${desiredOutputs
                .map(
                  (output) => `
                    <label class="choice">
                      <input type="checkbox" name="desired_output" value="${output}" ${output === "human-summary" ? "checked" : ""}>
                      <span>${escapeHtml(labelize(output))}</span>
                    </label>
                  `
                )
                .join("")}
            </div>
          </fieldset>
          <fieldset>
            <legend>Agents</legend>
            <div class="choice-grid">
              ${store.agents
                .map(
                  (agent, index) => `
                    <label class="choice">
                      <input type="checkbox" name="assigned_agents" value="${escapeHtml(agent.id)}" ${index < 2 ? "checked" : ""}>
                      <span>${escapeHtml(agent.name)}</span>
                    </label>
                  `
                )
                .join("")}
            </div>
          </fieldset>
          <div class="form-actions">
            <button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
            <button class="primary-button" type="submit">Create assignment</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

async function handleClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;

  const action = actionTarget.dataset.action;

  if (action === "open-assignment") {
    ui.modal = { type: "assignment", problemId: actionTarget.dataset.problemId ?? "" };
    render();
  }

  if (action === "close-modal") {
    if (actionTarget.classList.contains("modal-backdrop") && event.target !== actionTarget) return;
    ui.modal = null;
    render();
  }

  if (action === "reset-store") {
    const ok = window.confirm("Reset local data back to the seed workspace?");
    if (!ok) return;
    store = await resetStore();
    showToast("Local data reset");
    render();
  }

  if (action === "export-store") {
    downloadJson();
  }

  if (action === "set-verification") {
    const result = updateVerification(store, actionTarget.dataset.id, actionTarget.dataset.status);
    store = result.store;
    showToast("Verification updated");
    render();
  }
}

function handleSubmit(event) {
  if (event.target.id !== "assignment-form") return;
  event.preventDefault();

  const form = event.target;
  const formData = new FormData(form);
  const desiredOutput = formData.getAll("desired_output");
  const assignedAgents = formData.getAll("assigned_agents");

  if (!desiredOutput.length || !assignedAgents.length) {
    showToast("Choose at least one output and one agent");
    render();
    return;
  }

  const result = createAssignment(store, {
    problem_id: formData.get("problem_id"),
    task: formData.get("task"),
    prompt: formData.get("prompt"),
    desired_output: desiredOutput,
    assigned_agents: assignedAgents
  });

  store = result.store;
  ui.modal = null;
  showToast("Assignment created");
  window.location.hash = "#/assignments";
  render();
}

function downloadJson() {
  const blob = new Blob([exportStore(store)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "math-for-agents-store.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Export prepared");
  render();
}

function showToast(message) {
  ui.toast = message;
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    ui.toast = null;
    render();
  }, 2200);
}

function sortedPosts() {
  return [...store.posts].sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
}

function sortedVerifications() {
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return [...store.verifications].sort((left, right) => {
    if (left.status === "accepted" && right.status !== "accepted") return 1;
    if (right.status === "accepted" && left.status !== "accepted") return -1;
    return priorityRank[left.priority] - priorityRank[right.priority];
  });
}

function findProblem(id) {
  return store.problems.find((problem) => problem.id === id);
}

function findClaim(id) {
  return store.claims.find((claim) => claim.id === id);
}

function findArtifact(id) {
  return store.artifacts.find((artifact) => artifact.id === id);
}

function agentName(id) {
  if (id?.startsWith("human:")) return id.replace("human:", "Human ");
  return store.agents.find((agent) => agent.id === id)?.name ?? id ?? "Unknown";
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(labelize(status))}</span>`;
}

function statusClass(status) {
  if (["running", "active", "accepted", "done", "formal-proof", "proved informally"].includes(status)) return "good";
  if (["needs-review", "needs-human-review", "replay-requested", "in-review", "needs-more-detail"].includes(status)) return "warn";
  if (["open", "queued", "claimed", "plausible"].includes(status)) return "neutral";
  if (["refuted", "stopped"].includes(status)) return "bad";
  return "neutral";
}

function labelize(value) {
  return String(value ?? "").replaceAll("-", " ");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function initials(name) {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}
