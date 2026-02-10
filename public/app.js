const state = {
  sessions: [],
  selectedSessionId: null,
  selectedSession: null,
  mode: 'conversation',
  search: '',
  requestToken: 0,
  expandedMonths: new Set(),
  expandedDays: new Set(),
  expandedEntries: new Set(),
  hiddenRoles: new Set()
};

const elements = {
  searchInput: document.getElementById('searchInput'),
  refreshButton: document.getElementById('refreshButton'),
  sessionList: document.getElementById('sessionList'),
  sessionTitle: document.getElementById('sessionTitle'),
  sessionMeta: document.getElementById('sessionMeta'),
  sessionStats: document.getElementById('sessionStats'),
  roleFilters: document.getElementById('roleFilters'),
  timeline: document.getElementById('timeline'),
  modeInputs: Array.from(document.querySelectorAll('input[name="mode"]'))
};

function formatDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) {
    return 'unknown time';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '?';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function roleLabel(role) {
  const map = {
    user: 'User',
    assistant: 'Assistant',
    developer: 'Developer',
    system: 'System',
    tool_call: 'Tool Call',
    tool_output: 'Tool Output',
    reasoning: 'Reasoning',
    context: 'Context',
    metric: 'Metric',
    event: 'Event',
    tool: 'Tool'
  };
  return map[role] || role || 'Event';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeLinkUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return parsed.href;
    }
  } catch {
    return '#';
  }
  return '#';
}

function renderInlineMarkdown(text) {
  let rendered = escapeHtml(text);
  const codeTokens = [];

  rendered = rendered.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `__INLINE_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  rendered = rendered.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeLinkUrl(url.trim());
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  rendered = rendered.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  rendered = rendered.replace(/(^|[^\*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  rendered = rendered.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  codeTokens.forEach((html, index) => {
    rendered = rendered.replace(new RegExp(`__INLINE_CODE_${index}__`, 'g'), html);
  });

  return rendered;
}

function renderMarkdown(text) {
  const source = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  const lines = source.split('\n');
  const html = [];
  let inCodeFence = false;
  let codeFenceLang = '';
  let codeFenceLines = [];
  let inUnorderedList = false;
  let inOrderedList = false;

  const closeLists = () => {
    if (inUnorderedList) {
      html.push('</ul>');
      inUnorderedList = false;
    }
    if (inOrderedList) {
      html.push('</ol>');
      inOrderedList = false;
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\S+)?\s*$/);
    if (fenceMatch) {
      closeLists();
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceLang = fenceMatch[1] || '';
        codeFenceLines = [];
      } else {
        const langClass = codeFenceLang ? ` class="language-${escapeHtml(codeFenceLang)}"` : '';
        html.push(`<pre><code${langClass}>${escapeHtml(codeFenceLines.join('\n'))}</code></pre>`);
        inCodeFence = false;
        codeFenceLang = '';
        codeFenceLines = [];
      }
      continue;
    }

    if (inCodeFence) {
      codeFenceLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeLists();
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      closeLists();
      html.push('<hr>');
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeLists();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    const blockquote = line.match(/^>\s?(.*)$/);
    if (blockquote) {
      closeLists();
      html.push(`<blockquote>${renderInlineMarkdown(blockquote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      if (!inUnorderedList) {
        closeLists();
        html.push('<ul>');
        inUnorderedList = true;
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1].trim())}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      if (!inOrderedList) {
        closeLists();
        html.push('<ol>');
        inOrderedList = true;
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1].trim())}</li>`);
      continue;
    }

    closeLists();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  if (inCodeFence) {
    const langClass = codeFenceLang ? ` class="language-${escapeHtml(codeFenceLang)}"` : '';
    html.push(`<pre><code${langClass}>${escapeHtml(codeFenceLines.join('\n'))}</code></pre>`);
  }
  closeLists();

  if (html.length === 0) {
    return '<p>[No text payload]</p>';
  }
  return html.join('\n');
}

function shouldRenderMarkdown(entry) {
  return (
    entry &&
    (entry.role === 'user' ||
      entry.role === 'assistant' ||
      entry.role === 'developer' ||
      entry.role === 'system' ||
      entry.role === 'reasoning')
  );
}

function getSessionDateParts(session) {
  const rawDate = session.timestamp || session.mtime;
  if (!rawDate || Number.isNaN(Date.parse(rawDate))) {
    return {
      monthKey: 'unknown',
      dayKey: 'unknown',
      monthLabel: 'Unknown month',
      dayLabel: 'Unknown day'
    };
  }

  const date = new Date(rawDate);
  const year = date.getFullYear();
  const monthNumber = String(date.getMonth() + 1).padStart(2, '0');
  const dayNumber = String(date.getDate()).padStart(2, '0');
  return {
    monthKey: `${year}-${monthNumber}`,
    dayKey: `${year}-${monthNumber}-${dayNumber}`,
    monthLabel: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date),
    dayLabel: new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: '2-digit'
    }).format(date)
  };
}

function compareDateKeysDescending(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === 'unknown') {
    return 1;
  }
  if (right === 'unknown') {
    return -1;
  }
  return left < right ? 1 : -1;
}

function buildSessionTree(sessions) {
  const months = [];
  const monthMap = new Map();

  for (const session of sessions) {
    const parts = getSessionDateParts(session);
    let monthGroup = monthMap.get(parts.monthKey);
    if (!monthGroup) {
      monthGroup = {
        key: parts.monthKey,
        label: parts.monthLabel,
        days: [],
        dayMap: new Map()
      };
      monthMap.set(parts.monthKey, monthGroup);
      months.push(monthGroup);
    }

    let dayGroup = monthGroup.dayMap.get(parts.dayKey);
    if (!dayGroup) {
      dayGroup = {
        key: parts.dayKey,
        label: parts.dayLabel,
        sessions: []
      };
      monthGroup.dayMap.set(parts.dayKey, dayGroup);
      monthGroup.days.push(dayGroup);
    }

    dayGroup.sessions.push(session);
  }

  months.sort((a, b) => compareDateKeysDescending(a.key, b.key));
  for (const month of months) {
    month.days.sort((a, b) => compareDateKeysDescending(a.key, b.key));
  }

  return months;
}

function ensureTreeExpansion(months) {
  if (state.search.trim()) {
    return;
  }

  if (state.expandedMonths.size === 0 && months.length > 0) {
    state.expandedMonths.add(months[0].key);
  }
  if (
    state.expandedDays.size === 0 &&
    months.length > 0 &&
    months[0].days.length > 0
  ) {
    state.expandedDays.add(months[0].days[0].key);
  }

  if (state.selectedSessionId) {
    for (const month of months) {
      for (const day of month.days) {
        if (day.sessions.some((session) => session.id === state.selectedSessionId)) {
          state.expandedMonths.add(month.key);
          state.expandedDays.add(day.key);
          return;
        }
      }
    }
  }
}

function setTimelinePlaceholder(message) {
  elements.timeline.innerHTML = '';
  const node = document.createElement('p');
  node.className = 'placeholder';
  node.textContent = message;
  elements.timeline.appendChild(node);
}

function setCatalogPlaceholder(message) {
  elements.sessionList.innerHTML = '';
  const node = document.createElement('p');
  node.className = 'placeholder';
  node.textContent = message;
  elements.sessionList.appendChild(node);
}

function createStatChip(text) {
  const chip = document.createElement('span');
  chip.className = 'stat-chip';
  chip.textContent = text;
  return chip;
}

function renderSessionStats() {
  elements.sessionStats.innerHTML = '';
  if (!state.selectedSession) {
    return;
  }
  const { session, summary } = state.selectedSession;
  const chips = [
    `Source: ${session.source}`,
    `Updated: ${formatDate(session.timestamp)}`,
    `File size: ${formatBytes(session.sizeBytes)}`,
    `Entries: ${summary.totalEntries}`,
    `Conversation entries: ${summary.primaryEntries}`
  ];
  if (session.meta && session.meta.cliVersion) {
    chips.push(`CLI: ${session.meta.cliVersion}`);
  }
  for (const text of chips) {
    elements.sessionStats.appendChild(createStatChip(text));
  }
}

function getModeEntries() {
  if (!state.selectedSession) {
    return [];
  }
  const allEntries = Array.isArray(state.selectedSession.entries) ? state.selectedSession.entries : [];
  return state.mode === 'full' ? allEntries : allEntries.filter((entry) => entry && entry.primary);
}

function getEntryRole(entry) {
  if (!entry || typeof entry.role !== 'string' || !entry.role.trim()) {
    return 'event';
  }
  return entry.role;
}

function compareRolesForFilter(leftRole, rightRole) {
  const leftLabel = roleLabel(leftRole).toLowerCase();
  const rightLabel = roleLabel(rightRole).toLowerCase();
  if (leftLabel < rightLabel) {
    return -1;
  }
  if (leftLabel > rightLabel) {
    return 1;
  }
  return 0;
}

function renderRoleFilters() {
  elements.roleFilters.innerHTML = '';

  if (!state.selectedSession) {
    return;
  }

  const entries = getModeEntries();
  const roleCounts = new Map();
  for (const entry of entries) {
    const role = getEntryRole(entry);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
  }

  if (roleCounts.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'role-filters-empty';
    empty.textContent = 'No role filters available for this view.';
    elements.roleFilters.appendChild(empty);
    return;
  }

  const title = document.createElement('p');
  title.className = 'role-filters-title';
  title.textContent = 'Hide roles (checked = hidden):';
  elements.roleFilters.appendChild(title);

  const list = document.createElement('div');
  list.className = 'role-filters-list';

  const roles = Array.from(roleCounts.keys()).sort(compareRolesForFilter);
  roles.forEach((role) => {
    const label = document.createElement('label');
    label.className = 'role-filter-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.hiddenRoles.has(role);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.hiddenRoles.add(role);
      } else {
        state.hiddenRoles.delete(role);
      }
      renderTimeline();
    });

    const text = document.createElement('span');
    text.textContent = `${roleLabel(role)} (${roleCounts.get(role)})`;

    label.appendChild(checkbox);
    label.appendChild(text);
    list.appendChild(label);
  });

  elements.roleFilters.appendChild(list);
}

function renderTimeline() {
  if (!state.selectedSession) {
    setTimelinePlaceholder('Select a session from the catalog.');
    return;
  }

  const entries = getModeEntries().filter((entry) => !state.hiddenRoles.has(getEntryRole(entry)));

  elements.timeline.innerHTML = '';

  if (entries.length === 0) {
    const message =
      state.mode === 'full'
        ? 'No timeline records found for this session.'
        : 'No conversation messages available. Switch to Full timeline.';
    setTimelinePlaceholder(message);
    return;
  }

  entries.forEach((entry, index) => {
    const article = document.createElement('article');
    const safeRole = typeof entry.role === 'string' ? entry.role.replace(/[^a-z0-9_]/gi, '_') : 'event';
    article.className = `entry role-${safeRole}`;
    article.style.setProperty('--i', String(Math.min(index, 20)));
    const entryKey = `${entry.line}:${entry.eventType || 'event'}`;
    const isExpanded = state.expandedEntries.has(entryKey);
    if (!isExpanded) {
      article.classList.add('collapsed');
    }

    const header = document.createElement('header');
    header.className = 'entry-header';

    const roleTag = document.createElement('span');
    roleTag.className = 'role-tag';
    roleTag.textContent = roleLabel(entry.role);
    header.appendChild(roleTag);

    const typeTag = document.createElement('span');
    typeTag.className = 'type-tag';
    typeTag.textContent = entry.eventType || 'event';
    header.appendChild(typeTag);

    if (entry.timestamp) {
      const timestamp = document.createElement('span');
      timestamp.className = 'timestamp';
      timestamp.textContent = formatDate(entry.timestamp);
      header.appendChild(timestamp);
    }

    const line = document.createElement('span');
    line.className = 'line';
    line.textContent = `line ${entry.line}`;
    header.appendChild(line);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'entry-toggle';
    toggle.textContent = isExpanded ? 'Collapse' : 'Expand';
    toggle.addEventListener('click', () => {
      if (state.expandedEntries.has(entryKey)) {
        state.expandedEntries.delete(entryKey);
        article.classList.add('collapsed');
        toggle.textContent = 'Expand';
      } else {
        state.expandedEntries.add(entryKey);
        article.classList.remove('collapsed');
        toggle.textContent = 'Collapse';
      }
    });
    header.appendChild(toggle);

    article.appendChild(header);

    const bodyText =
      typeof entry.text === 'string' && entry.text.trim() ? entry.text : '[No text payload]';
    let body;
    if (shouldRenderMarkdown(entry)) {
      body = document.createElement('div');
      body.className = 'entry-body markdown-body';
      body.innerHTML = renderMarkdown(bodyText);
    } else {
      body = document.createElement('pre');
      body.className = 'entry-body plain-body';
      body.textContent = bodyText;
    }
    article.appendChild(body);

    elements.timeline.appendChild(article);
  });
}

function renderSessionDetail() {
  if (!state.selectedSession) {
    elements.sessionTitle.textContent = 'Select a session';
    elements.sessionMeta.textContent = 'No session selected.';
    elements.sessionStats.innerHTML = '';
    elements.roleFilters.innerHTML = '';
    setTimelinePlaceholder('Select a session from the catalog.');
    return;
  }

  const { session } = state.selectedSession;
  elements.sessionTitle.textContent = session.fileName;
  const metaParts = [session.relativePath, formatDate(session.timestamp)];
  if (session.meta && session.meta.cwd) {
    metaParts.push(`cwd: ${session.meta.cwd}`);
  }
  elements.sessionMeta.textContent = metaParts.filter(Boolean).join(' • ');
  renderSessionStats();
  renderRoleFilters();
  renderTimeline();
}

function sessionMatchesSearch(session, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    session.fileName,
    session.relativePath,
    session.source,
    session.meta && session.meta.cwd ? session.meta.cwd : '',
    session.meta && session.meta.sessionId ? session.meta.sessionId : ''
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderCatalog() {
  const filtered = state.sessions.filter((session) => sessionMatchesSearch(session, state.search));
  const months = buildSessionTree(filtered);
  ensureTreeExpansion(months);
  elements.sessionList.innerHTML = '';

  if (months.length === 0) {
    setCatalogPlaceholder('No sessions found for this filter.');
    return;
  }

  months.forEach((month) => {
    const monthDetails = document.createElement('details');
    monthDetails.className = 'tree-month';
    monthDetails.open = state.search.trim() ? true : state.expandedMonths.has(month.key);
    monthDetails.addEventListener('toggle', () => {
      if (monthDetails.open) {
        state.expandedMonths.add(month.key);
      } else {
        state.expandedMonths.delete(month.key);
      }
    });

    const monthSummary = document.createElement('summary');
    monthSummary.className = 'tree-summary';

    const monthLabel = document.createElement('span');
    monthLabel.textContent = month.label;
    monthSummary.appendChild(monthLabel);

    const monthCount = document.createElement('span');
    monthCount.className = 'tree-count';
    monthCount.textContent = `${month.days.reduce((acc, day) => acc + day.sessions.length, 0)} sessions`;
    monthSummary.appendChild(monthCount);
    monthDetails.appendChild(monthSummary);

    const dayContainer = document.createElement('div');
    dayContainer.className = 'tree-children';

    month.days.forEach((day) => {
      const dayDetails = document.createElement('details');
      dayDetails.className = 'tree-day';
      dayDetails.open = state.search.trim() ? true : state.expandedDays.has(day.key);
      dayDetails.addEventListener('toggle', () => {
        if (dayDetails.open) {
          state.expandedDays.add(day.key);
        } else {
          state.expandedDays.delete(day.key);
        }
      });

      const daySummary = document.createElement('summary');
      daySummary.className = 'tree-summary day-summary';

      const dayLabel = document.createElement('span');
      dayLabel.textContent = day.label;
      daySummary.appendChild(dayLabel);

      const dayCount = document.createElement('span');
      dayCount.className = 'tree-count';
      dayCount.textContent = `${day.sessions.length} sessions`;
      daySummary.appendChild(dayCount);
      dayDetails.appendChild(daySummary);

      const daySessions = document.createElement('div');
      daySessions.className = 'tree-day-sessions';

      day.sessions.forEach((session) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'session-card';
        if (session.id === state.selectedSessionId) {
          button.classList.add('active');
        }

        button.addEventListener('click', () => {
          selectSession(session.id);
        });

        const topRow = document.createElement('div');
        topRow.className = 'session-card-header';

        const title = document.createElement('p');
        title.className = 'session-card-title';
        title.textContent = formatDate(session.timestamp);
        topRow.appendChild(title);

        button.appendChild(topRow);
        daySessions.appendChild(button);
      });

      dayDetails.appendChild(daySessions);
      dayContainer.appendChild(dayDetails);
    });

    monthDetails.appendChild(dayContainer);
    elements.sessionList.appendChild(monthDetails);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data && data.error ? data.error : `Request failed (${response.status})`;
    throw new Error(error);
  }
  return data;
}

async function loadSessions() {
  setCatalogPlaceholder('Loading sessions...');
  const data = await fetchJson('/api/sessions');
  state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  renderCatalog();

  if (state.sessions.length === 0) {
    state.selectedSessionId = null;
    state.selectedSession = null;
    renderSessionDetail();
    return;
  }

  const preferred =
    state.selectedSessionId && state.sessions.some((session) => session.id === state.selectedSessionId)
      ? state.selectedSessionId
      : state.sessions[0].id;
  await selectSession(preferred);
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.selectedSession = null;
  state.expandedEntries.clear();
  renderCatalog();
  renderSessionDetail();
  setTimelinePlaceholder('Loading session history...');

  const token = state.requestToken + 1;
  state.requestToken = token;

  try {
    const data = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (token !== state.requestToken) {
      return;
    }
    state.selectedSession = data;
    renderSessionDetail();
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }
    setTimelinePlaceholder(`Failed to load session: ${error.message}`);
  }
}

function attachEvents() {
  elements.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderCatalog();
  });

  elements.refreshButton.addEventListener('click', async () => {
    try {
      await loadSessions();
    } catch (error) {
      setCatalogPlaceholder(`Failed to load sessions: ${error.message}`);
      setTimelinePlaceholder('Unable to refresh sessions.');
    }
  });

  for (const input of elements.modeInputs) {
    input.addEventListener('change', (event) => {
      if (event.target.checked) {
        state.mode = event.target.value;
        renderRoleFilters();
        renderTimeline();
      }
    });
  }
}

async function bootstrap() {
  attachEvents();
  try {
    await loadSessions();
  } catch (error) {
    setCatalogPlaceholder(`Failed to load sessions: ${error.message}`);
    setTimelinePlaceholder('Unable to load session data.');
  }
}

bootstrap();
