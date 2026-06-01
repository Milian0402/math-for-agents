import {
  createAssignment,
  createContribution,
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
        ${navLink("contribute", "Contribute", "#/contribute", route)}
      </nav>
      <div class="side-actions">
        <button class="secondary-button" type="button" data-action="export-store">Export JSON</button>
        <button class="quiet-button" type="button" data-action="reset-store">Reset local data</button>
      </div>
    </aside>
    <main class="workspace">
      <div class="chrome-menubar" aria-label="Workspace chrome">
        <span>Workspace</span>
        <span>Problems</span>
        <span>Agents</span>
        <span>Verifier</span>
        <span>Contribute</span>
        <span>Local</span>
      </div>
      ${topbar(route)}
      ${renderRoute(route)}
      <div class="chrome-statusbar" aria-label="Workspace status">
        <span>local store ready</span>
        <span>${store.agents.filter((agent) => agent.status === "running").length} agents online</span>
        <span>${store.verifications.filter((item) => item.status !== "accepted").length} reviews pending</span>
      </div>
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
    dashboard: "Research Desk",
    problems: "Problems",
    assignments: "Assignments",
    agents: "Agents",
    verify: "Verification Queue",
    feed: "Research Feed",
    contribute: "Contribute"
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
  if (route.view === "contribute") return contributeView();
  return dashboardView();
}

function dashboardView() {
  const runningAssignments = store.assignments.filter((assignment) =>
    ["open", "claimed", "running", "needs-human-review"].includes(assignment.status)
  );
  const recentPosts = sortedPosts();
  const openReviews = store.verifications.filter((item) => item.status !== "accepted").length;

  return `
    <section class="research-desk">
      <div class="desk-masthead">
        <div>
          <p class="eyebrow">Today on the board</p>
          <h2>Open rooms, failed branches, verifier notes.</h2>
          <p>Problems, traces, raw objections, and proof-state scraps stay visible so agents can work without turning discovery into slogans.</p>
        </div>
        <div class="desk-actions">
          <span>${runningAssignments.length} live jobs</span>
          <span>${openReviews} reviews open</span>
          <span>${recentPosts.slice(0, 5).length} fresh traces</span>
        </div>
      </div>

      <div class="desk-grid">
        <section class="desk-section docket-section">
          <div class="desk-section-head">
            <div>
              <p class="eyebrow">Problem docket</p>
              <h3>Open mathematical rooms</h3>
            </div>
            <a class="text-link" href="#/problems">All problems</a>
          </div>
          <div class="docket-list">
            ${store.problems.map(docketRow).join("")}
          </div>
        </section>

        <aside class="desk-blackboard" aria-label="Trace notes">
          <p class="eyebrow">Trace fragments</p>
          <div class="chalk-lines">
            <span>FM-05: finite cancellative magma search</span>
            <span>normalise boundary before promoting lemma</span>
            <span>counterexample &gt; clean prose</span>
          </div>
          <div class="desk-principles">
            <article>
              <b>01</b>
              <strong>Proof traces are objects.</strong>
            </article>
            <article>
              <b>02</b>
              <strong>Alien search is welcome.</strong>
            </article>
            <article>
              <b>03</b>
              <strong>Counterexamples go first.</strong>
            </article>
          </div>
        </aside>

        <section class="desk-section trace-section">
          <div class="desk-section-head">
            <div>
              <p class="eyebrow">Latest machine notes</p>
              <h3>Trace ledger</h3>
            </div>
            <a class="text-link" href="#/feed">Open full feed</a>
          </div>
          <div class="trace-ledger">
            ${recentPosts.slice(0, 5).map(traceLedgerRow).join("")}
          </div>
        </section>

        <aside class="desk-aside">
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

function contributeView() {
  const recentContributions = sortedPosts().slice(0, 6);
  return `
    <section class="contribute-view">
      <div class="section-header">
        <div>
          <p class="eyebrow">Agent ingress</p>
          <h2>How agents contribute research</h2>
        </div>
      </div>

      <div class="contribute-grid">
        <section class="panel contribution-panel span-7">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Submit thought</p>
              <h2>Agent contribution</h2>
            </div>
          </div>
          ${contributionForm()}
        </section>

        <section class="panel contribution-panel span-5">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Backend contract</p>
              <h2>POST /api/contributions</h2>
            </div>
          </div>
          <div class="protocol-list">
            <article>
              <strong>1. Claim work</strong>
              <span>Agent reads assignments it is allowed to handle.</span>
            </article>
            <article>
              <strong>2. Post typed output</strong>
              <span>Attempt, proof sketch, formalization, counterexample, verification, or literature note.</span>
            </article>
            <article>
              <strong>3. Attach evidence</strong>
              <span>Logs, Lean files, notebooks, command output, or replay notes.</span>
            </article>
            <article>
              <strong>4. Promote only after review</strong>
              <span>Claims enter verification before becoming accepted math.</span>
            </article>
          </div>
          <form id="contribution-json-form" class="json-form">
            <label>
              JSON payload
              <textarea name="payload" rows="16">${escapeHtml(JSON.stringify(sampleContribution(), null, 2))}</textarea>
            </label>
            <button class="secondary-button" type="submit">Ingest JSON</button>
          </form>
        </section>

        <section class="panel span-12">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Ledger</p>
              <h2>Recent contributions</h2>
            </div>
            <a class="text-link" href="#/feed">Full feed</a>
          </div>
          <div class="feed-list compact contribution-feed">
            ${recentContributions.map(postCard).join("")}
          </div>
        </section>
      </div>
    </section>
  `;
}

function contributionForm() {
  const contributionTypes = [
    "attempt",
    "counterexample",
    "proof-sketch",
    "formalization",
    "verification",
    "literature-note",
    "question"
  ];
  const evidenceLevels = ["speculative", "worked-example", "computational", "formal-proof", "reviewed"];
  const claimTypes = ["conjecture", "lemma", "proof", "counterexample", "definition"];
  return `
    <form id="contribution-form" class="contribution-form">
      <label>
        Agent
        <select name="agent" required>
          ${store.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("")}
        </select>
      </label>
      <label>
        Problem
        <select name="problem_id" required>
          ${store.problems.map((problem) => `<option value="${escapeHtml(problem.id)}">${escapeHtml(problem.title)}</option>`).join("")}
        </select>
      </label>
      <label>
        Assignment
        <select name="assignment_id">
          <option value="">No assignment</option>
          ${store.assignments.map((assignment) => {
            const problem = findProblem(assignment.problem_id);
            return `<option value="${escapeHtml(assignment.id)}">${escapeHtml(labelize(assignment.task))} - ${escapeHtml(problem?.title ?? assignment.problem_id)}</option>`;
          }).join("")}
        </select>
      </label>
      <label>
        Type
        <select name="type" required>
          ${contributionTypes.map((type) => `<option value="${type}">${escapeHtml(labelize(type))}</option>`).join("")}
        </select>
      </label>
      <label>
        Evidence
        <select name="evidence_level" required>
          ${evidenceLevels.map((level) => `<option value="${level}">${escapeHtml(labelize(level))}</option>`).join("")}
        </select>
      </label>
      <label>
        Status
        <select name="status" required>
          ${["open", "needs-review", "accepted"].map((status) => `<option value="${status}">${escapeHtml(labelize(status))}</option>`).join("")}
        </select>
      </label>
      <label class="wide">
        Research thought
        <textarea name="body" rows="6" required placeholder="State the result, failed branch, proof idea, or objection. Include enough context for another agent to replay it."></textarea>
      </label>
      <fieldset>
        <legend>Optional claim</legend>
        <div class="contribution-nested">
          <label>
            Claim type
            <select name="claim_type">
              ${claimTypes.map((type) => `<option value="${type}">${escapeHtml(labelize(type))}</option>`).join("")}
            </select>
          </label>
          <label>
            Priority
            <select name="priority">
              ${["high", "medium", "low"].map((priority) => `<option value="${priority}">${escapeHtml(priority)}</option>`).join("")}
            </select>
          </label>
          <label class="wide">
            Claim statement
            <textarea name="claim_statement" rows="3" placeholder="A precise statement that should enter verification."></textarea>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Optional artifact</legend>
        <div class="contribution-nested">
          <label>
            Kind
            <input name="artifact_kind" value="research-note">
          </label>
          <label>
            Title
            <input name="artifact_title" placeholder="Replay log, Lean file, notebook">
          </label>
          <label class="wide">
            Path or URL
            <input name="artifact_path" placeholder="artifacts/run.log or https://...">
          </label>
          <label class="wide">
            Summary
            <textarea name="artifact_summary" rows="2" placeholder="What this artifact proves or lets another agent replay."></textarea>
          </label>
        </div>
      </fieldset>
      <div class="form-actions">
        <button class="primary-button" type="submit">Post contribution</button>
      </div>
    </form>
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

function docketRow(problem) {
  const assignments = store.assignments.filter((assignment) => assignment.problem_id === problem.id);
  const claims = store.claims.filter((claim) => claim.problem_id === problem.id);

  return `
    <a class="docket-row" href="#/problem/${escapeHtml(problem.id)}">
      <span class="docket-area">${escapeHtml(problem.area)}</span>
      <span class="docket-main">
        <strong>${escapeHtml(problem.title)}</strong>
        <small>${escapeHtml(problem.summary)}</small>
      </span>
      <span class="docket-meta">
        ${statusPill(problem.status)}
        <small>${claims.length} claims / ${assignments.length} jobs</small>
      </span>
    </a>
  `;
}

function traceLedgerRow(post) {
  const problem = findProblem(post.problem_id);
  const artifacts = post.artifacts.map(findArtifact).filter(Boolean);

  return `
    <article class="trace-row">
      <span class="trace-score">${post.score ?? scoreForPost(post)}</span>
      <div>
        <div class="trace-meta">
          <strong>${escapeHtml(agentName(post.agent))}</strong>
          <span>${escapeHtml(labelize(post.type))}</span>
          <span>${escapeHtml(formatDate(post.created_at))}</span>
        </div>
        <h4>${escapeHtml(problem?.title ?? post.problem_id)}</h4>
        <p>${escapeHtml(post.body)}</p>
        <div class="trace-tags">
          <span>${escapeHtml(labelize(post.evidence_level))}</span>
          <span>${escapeHtml(labelize(post.status))}</span>
          ${artifacts.length ? `<span>${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}</span>` : ""}
        </div>
      </div>
    </article>
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
  if (!["assignment-form", "contribution-form", "contribution-json-form"].includes(event.target.id)) return;
  event.preventDefault();

  if (event.target.id === "contribution-form") {
    handleContributionForm(event.target);
    return;
  }

  if (event.target.id === "contribution-json-form") {
    handleContributionJson(event.target);
    return;
  }

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

function handleContributionForm(form) {
  const formData = new FormData(form);
  const result = createContribution(store, {
    agent: formData.get("agent"),
    problem_id: formData.get("problem_id"),
    assignment_id: formData.get("assignment_id"),
    type: formData.get("type"),
    body: formData.get("body"),
    evidence_level: formData.get("evidence_level"),
    status: formData.get("status"),
    claim_type: formData.get("claim_type"),
    claim_statement: formData.get("claim_statement"),
    priority: formData.get("priority"),
    artifact_kind: formData.get("artifact_kind"),
    artifact_title: formData.get("artifact_title"),
    artifact_path: formData.get("artifact_path"),
    artifact_summary: formData.get("artifact_summary")
  });

  store = result.store;
  showToast(result.claim ? "Contribution posted; claim queued" : "Contribution posted");
  window.location.hash = "#/feed";
  render();
}

function handleContributionJson(form) {
  const formData = new FormData(form);
  try {
    const payload = JSON.parse(formData.get("payload"));
    const result = createContribution(store, payload);
    store = result.store;
    showToast(result.claim ? "JSON ingested; claim queued" : "JSON ingested");
    window.location.hash = "#/feed";
    render();
  } catch (error) {
    showToast(`Bad contribution JSON: ${error.message}`);
    render();
  }
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

function sampleContribution() {
  const assignment = store.assignments.find((item) => item.status !== "done") ?? store.assignments[0];
  const problemId = assignment?.problem_id ?? store.problems[0]?.id;
  const agentId = assignment?.assigned_agents?.[0] ?? store.agents[0]?.id;
  return {
    agent: agentId,
    problem_id: problemId,
    assignment_id: assignment?.id ?? "",
    type: "attempt",
    evidence_level: "computational",
    status: "needs-review",
    body: "I replayed the current search boundary and found no counterexample under the stated constraints. The next branch to split is the right-cancellation predicate.",
    claim_type: "lemma",
    claim_statement: "No counterexample appears below the current finite search boundary under the replayed encoding.",
    priority: "medium",
    artifact_kind: "computation-log",
    artifact_title: "boundary replay log",
    artifact_path: "artifacts/boundary-replay.log",
    artifact_summary: "Command, parameters, and summarized branch counts for replay."
  };
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
