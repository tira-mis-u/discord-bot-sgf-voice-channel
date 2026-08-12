// TypeScript source for the browser dashboard. Build output: public/dashboard.js.
// @ts-nocheck
const state = { guilds: [], guildId: '', detail: null, runtime: null, editingProduct: null, members: [], membersLoadedAt: 0, membersLoading: false, membersRetryAt: 0, memberPage: 1, liveRooms: [], liveRoomsLoadedAt: 0, liveRoomsLoading: false, passwordRoomId: '' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const vnd = (value) => `${new Intl.NumberFormat('vi-VN').format(Number(value || 0))} ₫`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character] || character));
const pageNames = { store: 'Cửa hàng', rooms: 'Phòng đang mở', overview: 'Tổng quan', voice: 'Creator channels', products: 'Premium & giá', payments: 'Thanh toán', members: 'Thành viên', integration: 'Tích hợp SGF' };

function setupTheme() {
  const saved = localStorage.getItem('sgf-theme');
  const preferredDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (preferredDark ? 'dark' : 'light'));
  $('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('sgf-theme', dark ? 'dark' : 'light');
  const toggle = $('#themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(dark));
    $('#themeToggleLabel').textContent = dark ? 'Dark' : 'Light';
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

function toast(message, kind = 'good') {
  const el = $('#toast');
  el.className = `toast ${kind === 'bad' ? 'toast-bad' : ''}`;
  $('span', el).textContent = message;
  el.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove('show'), 3000);
}

function goLogin(returnTo = '/') {
  window.location.href = `/auth/discord?returnTo=${encodeURIComponent(returnTo)}`;
}

function avatarUrl(guild) {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : '';
}

function renderRuntime(runtime) {
  state.runtime = runtime;
  const pill = $('#connectionPill');
  const diagnostics = $('#runtimeDiagnostics');
  $('#heroServerCount').textContent = new Intl.NumberFormat('vi-VN').format(Number(runtime.guildCount || 0));
  $('#heroUserCount').textContent = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(runtime.userCount || 0));
  if (runtime.online) {
    pill.className = 'status-pill status-good';
    pill.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Bot online</span>';
    diagnostics.className = 'runtime-diagnostics hidden';
    diagnostics.textContent = '';
  } else {
    pill.className = 'status-pill status-warn';
    pill.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><span>Bot chưa online</span>';
    diagnostics.className = 'runtime-diagnostics warn';
    diagnostics.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(runtime.lastError || 'Kiểm tra cấu hình bot.')}<br><span>OAuth redirect: <code>${esc(runtime.redirectUri)}</code></span>${runtime.inviteUrl ? ` <a href="${runtime.inviteUrl}" target="_blank" rel="noreferrer">Mời bot đúng scope</a>` : ''}`;
  }
}

function showLoggedOut() {
  document.body.classList.remove('dashboard-active');
  $('#landing').classList.remove('hidden');
  $('#dashboard').classList.add('hidden');
  $('#loginButton').classList.remove('hidden');
  $('#userChip').classList.add('hidden');
}

function showAuthenticated(user) {
  document.body.classList.add('dashboard-active');
  $('#landing').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  $('#loginButton').classList.add('hidden');
  $('#userChip').classList.remove('hidden');
  $('#headerUserName').textContent = user?.globalName || user?.username || 'Discord user';
}

function userIcon(user) {
  const avatar = user?.avatar && user?.id ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : '';
  $('#headerUserAvatar').innerHTML = avatar ? `<img src="${avatar}" alt="" />` : '<i class="fa-solid fa-user"></i>';
}

function renderGuildCards(guilds = state.guilds) {
  const grid = $('#serverGrid');
  const query = $('#serverSearch').value.trim().toLowerCase();
  const visible = guilds.filter((guild) => guild.name.toLowerCase().includes(query));
  $('#serverCount').textContent = `${visible.length} server khả dụng`;
  grid.innerHTML = visible.map((guild) => {
    const icon = avatarUrl(guild);
    return `<article class="server-card choose-server" data-id="${esc(guild.id)}" role="button" tabindex="0" aria-label="Mở server ${esc(guild.name)}"><div class="server-card-top"><span class="server-card-icon">${icon ? `<img src="${icon}" alt="" />` : '<i class="fa-brands fa-discord"></i>'}</span><span class="server-card-arrow"><i class="fa-solid fa-arrow-right"></i></span></div><h3>${esc(guild.name)}</h3><span class="server-card-meta ${guild.canManage ? '' : 'server-store-meta'}"><i class="fa-solid ${guild.canManage ? 'fa-user-shield' : 'fa-store'}"></i> ${guild.canManage ? 'Quản trị đầy đủ' : 'Cửa hàng Premium'}</span><span class="server-card-id">ID ${esc(guild.id)}</span></article>`;
  }).join('');
  $$('.choose-server').forEach((card) => {
    card.addEventListener('click', () => selectGuild(card.dataset.id));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGuild(card.dataset.id); } });
  });
  $('#noServers').classList.toggle('hidden', visible.length > 0 || guilds.length > 0);
  if (guilds.length > 0 && visible.length === 0) grid.innerHTML = '<div class="inline-empty"><i class="fa-solid fa-magnifying-glass"></i><span>Không tìm thấy server phù hợp.</span></div>';
}

async function loadGuilds() {
  const result = await api('/api/guilds');
  state.guilds = result.guilds || [];
  renderGuildCards();
  $('#noServers').classList.toggle('hidden', state.guilds.length > 0);
}

function applyAccessMode() {
  const admin = Boolean(state.detail?.canManage);
  $$('.admin-only-nav').forEach((element) => element.classList.toggle('hidden', !admin));
  $$('.admin-only-panel').forEach((element) => element.classList.toggle('enabled', admin));
  $$('.admin-only-control').forEach((element) => element.classList.toggle('hidden', !admin));
}

function setPage(page) {
  if (!state.guildId) return;
  if (!state.detail?.canManage && !['store', 'rooms'].includes(page)) page = 'store';
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === page));
  $('#breadcrumbPage').textContent = pageNames[page] || page;
  history.replaceState(null, '', `#${page}`);
  if (page === 'members' && state.detail?.canManage) loadMembers();
  if (page === 'rooms') loadLiveRooms();
}

async function selectGuild(guildId) {
  state.guildId = guildId;
  state.members = [];
  state.membersLoadedAt = 0;
  state.membersLoading = false;
  state.membersRetryAt = 0;
  state.memberPage = 1;
  state.liveRooms = [];
  state.liveRoomsLoadedAt = 0;
  state.liveRoomsLoading = false;
  const guild = state.guilds.find((item) => item.id === guildId);
  $('#serverPickerView').classList.add('hidden');
  $('#workspaceView').classList.remove('hidden');
  $('#dashboardShell').classList.remove('no-server-selected');
  $('#sidebarServerName').textContent = guild?.name || 'Server';
  const icon = avatarUrl(guild || {});
  $('#sidebarServerIcon').innerHTML = icon ? `<img src="${icon}" alt="" />` : '<i class="fa-brands fa-discord"></i>';
  await loadGuild(guildId);
}

function showServerPicker() {
  state.guildId = '';
  state.detail = null;
  $('#serverPickerView').classList.remove('hidden');
  $('#workspaceView').classList.add('hidden');
  $('#dashboardShell').classList.add('no-server-selected');
  $('#postPanelButton').classList.add('hidden');
  $('#breadcrumbPage').textContent = 'Chọn server';
  $('#serverSearch').value = '';
  renderGuildCards();
}

async function loadGuild(guildId) {
  try {
    state.detail = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
    renderDetail();
    setPage(state.detail.canManage ? 'overview' : 'store');
  } catch (error) {
    toast(error.message, 'bad');
    showServerPicker();
  }
}

function renderDetail() {
  const { guild, settings, products, stats, sepay, integration } = state.detail;
  applyAccessMode();
  $('#workspaceTitle').textContent = guild.name || settings.guildName || 'Server';
  $('#workspaceSubtitle').textContent = state.detail.canManage ? `${settings.creatorChannels.length} creator channel đang cấu hình` : 'Cửa hàng dành cho thành viên server';
  $('#navRoomCount').textContent = stats.activeRooms;
  $('#liveRoomCount').textContent = stats.activeRooms;
  const subscription = state.detail.subscription || { premium: false, expiresAt: '', freeEditableLimit: 1 };
  $('#roomPlanStatus').innerHTML = subscription.premium
    ? `<i class="fa-solid fa-crown"></i> Premium${subscription.expiresAt ? ` đến ${new Date(subscription.expiresAt).toLocaleDateString('vi-VN')}` : ''}`
    : `<i class="fa-solid fa-seedling"></i> Free - ${subscription.freeEditableLimit || 1} phòng editable`;
  $('#statRevenue').textContent = vnd(stats.paidTotalVnd);
  $('#revenueBig').textContent = vnd(stats.paidTotalVnd);
  $('#statDonors').textContent = stats.donorCount;
  $('#statRooms').textContent = stats.activeRooms;
  $('#statPending').textContent = stats.pendingCount;
  $('#todayLabel').textContent = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
  $('#sepayMiniStatus').textContent = sepay.webhookConfigured && sepay.apiTokenConfigured ? 'Webhook + API v2 sẵn sàng' : sepay.webhookConfigured ? 'Webhook đã cấu hình' : sepay.apiTokenConfigured ? 'API v2 đối soát đã cấu hình' : 'Cần cấu hình SePay';
  fillSettings(settings);
  renderCreators(settings.creatorChannels);
  renderProducts(products);
  renderStore(products);
  renderIntegration(sepay, integration);
  renderSetupProgress(settings, products, sepay);
  if (state.detail.canManage) loadPayments(true);
}

function renderSetupProgress(settings, products, sepay) {
  const completed = [settings.creatorChannels.length > 0, products.length > 0, Boolean(sepay.dynamicQrConfigured || sepay.staticQrConfigured), Boolean(sepay.webhookConfigured || sepay.apiTokenConfigured)];
  const count = completed.filter(Boolean).length;
  $('#setupProgressText').textContent = `${count}/4`;
  $('#setupProgressBar').style.width = `${count * 25}%`;
}

function fillSettings(settings) {
  $('#roomNameTemplate').value = settings.roomNameTemplate || "{user}'s room";
  $('#defaultRoomCategoryId').value = settings.defaultRoomCategoryId || '';
  $('#controlChannelId').value = settings.controlChannelId || '';
  $('#paymentPanelChannelId').value = settings.paymentPanelChannelId || '';
  $('#premiumRoleId').value = settings.premiumRoleId || '';
  $('#bankCode').value = settings.bankCode || '';
  $('#bankAccountNumber').value = settings.bankAccountNumber || '';
  $('#bankAccountName').value = settings.bankAccountName || '';
  $('#donationMinVnd').value = settings.donationMinVnd || 1000;
  $('#staticQrUrl').value = settings.staticQrUrl || '';
}

function renderCreators(rows = []) {
  $('#creatorEmpty').classList.toggle('hidden', rows.length > 0);
  $('#creatorRows').innerHTML = rows.map((row, index) => `<div class="creator-row creator-row-extended" data-index="${index}">
    <label><span>CHANNEL ID</span><input data-field="channelId" value="${esc(row.channelId)}" placeholder="Voice channel ID" /></label>
    <label><span>TÊN TRIGGER</span><input data-field="label" value="${esc(row.label || '')}" placeholder="Tên trigger" /></label>
    <label><span>CHẾ ĐỘ</span><select data-field="mode"><option value="basic" ${row.mode === 'basic' ? 'selected' : ''}>Không edit</option><option value="editable" ${row.mode === 'editable' ? 'selected' : ''}>Editable</option></select></label>
    <label><span>CATEGORY</span><input data-field="categoryId" value="${esc(row.categoryId || '')}" placeholder="Category ID" /></label>
    <label><span>ROLE ĐƯỢC TẠO</span><input data-field="allowedRoleId" value="${esc(row.allowedRoleId || '')}" placeholder="Trống = mọi người" /></label>
    <label><span>LOG RA/VÀO</span><select data-field="notifyJoinLeave"><option value="false" ${!row.notifyJoinLeave ? 'selected' : ''}>Tắt</option><option value="true" ${row.notifyJoinLeave ? 'selected' : ''}>Bật</option></select></label>
    <label><span>AUTO HOST</span><select data-field="autoTransferOwner"><option value="true" ${row.autoTransferOwner !== false ? 'selected' : ''}>Bật</option><option value="false" ${row.autoTransferOwner === false ? 'selected' : ''}>Tắt</option></select></label>
    <button class="icon-button icon-button-danger remove-creator" type="button" title="Xóa trigger" aria-label="Xóa trigger"><i class="fa-solid fa-trash"></i></button>
  </div>`).join('');
  $$('.remove-creator').forEach((button) => button.addEventListener('click', (event) => { event.currentTarget.closest('.creator-row').remove(); $('#creatorEmpty').classList.toggle('hidden', $$('.creator-row').length > 0); }));
}

function readCreators() {
  return $$('.creator-row').map((row) => ({
    channelId: $('[data-field="channelId"]', row).value.trim(),
    label: $('[data-field="label"]', row).value.trim() || 'Tạo phòng',
    mode: $('[data-field="mode"]', row).value,
    categoryId: $('[data-field="categoryId"]', row).value.trim(),
    allowedRoleId: $('[data-field="allowedRoleId"]', row).value.trim(),
    notifyJoinLeave: $('[data-field="notifyJoinLeave"]', row).value === 'true',
    autoTransferOwner: $('[data-field="autoTransferOwner"]', row).value === 'true',
  })).filter((row) => row.channelId);
}

async function saveVoiceSettings() {
  try {
    const body = { creatorChannels: readCreators(), premiumRoleId: $('#premiumRoleId').value.trim(), controlChannelId: $('#controlChannelId').value.trim(), paymentPanelChannelId: $('#paymentPanelChannelId').value.trim(), defaultRoomCategoryId: $('#defaultRoomCategoryId').value.trim(), roomNameTemplate: $('#roomNameTemplate').value.trim(), donationMinVnd: state.detail.settings.donationMinVnd, bankCode: state.detail.settings.bankCode, bankAccountNumber: state.detail.settings.bankAccountNumber, bankAccountName: state.detail.settings.bankAccountName, staticQrUrl: state.detail.settings.staticQrUrl };
    const result = await api(`/api/guilds/${state.guildId}/settings`, { method: 'PUT', body: JSON.stringify(body) });
    state.detail.settings = result.settings;
    renderCreators(result.settings.creatorChannels);
    renderSetupProgress(result.settings, state.detail.products, state.detail.sepay);
    toast('Đã lưu cấu hình voice.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function createCreatorChannel(event) {
  event.preventDefault();
  if (!state.guildId || !state.detail?.canManage) {
    toast('Hãy chọn một server bạn có quyền quản trị trước.', 'bad');
    return;
  }
  const channelId = $('#newCreatorChannelId').value.trim();
  const creator = {
    channelId,
    label: $('#newCreatorLabel').value.trim() || 'Tạo phòng',
    mode: $('#newCreatorMode').value,
    categoryId: $('#newCreatorCategoryId').value.trim(),
    allowedRoleId: $('#newCreatorAllowedRoleId').value.trim(),
    notifyJoinLeave: $('#newCreatorNotify').checked,
    autoTransferOwner: $('#newCreatorAutoHost').checked,
  };
  if (channelId && state.detail.settings.creatorChannels.some((item) => item.channelId === channelId)) {
    $('#creatorSetupMessage').textContent = 'Kênh này đã có trong danh sách trigger.';
    toast('Kênh này đã được setup.', 'bad');
    return;
  }
  const button = $('#createCreatorButton');
  button.disabled = true;
  $('#creatorSetupMessage').textContent = channelId ? 'Đang gắn voice channel có sẵn…' : 'Bot đang tạo voice trigger mới…';
  try {
    const result = channelId
      ? await api(`/api/guilds/${state.guildId}/settings`, { method: 'PUT', body: JSON.stringify({ creatorChannels: [...state.detail.settings.creatorChannels, creator] }) })
      : await api(`/api/guilds/${state.guildId}/creator-channels`, { method: 'POST', body: JSON.stringify({ ...creator, channelId: undefined, categoryId: creator.categoryId || undefined, allowedRoleId: creator.allowedRoleId || undefined }) });
    state.detail.settings = result.settings;
    fillSettings(result.settings);
    renderCreators(result.settings.creatorChannels);
    renderSetupProgress(result.settings, state.detail.products, state.detail.sepay);
    $('#newCreatorChannelId').value = '';
    $('#newCreatorLabel').value = 'Tạo phòng';
    $('#creatorSetupMessage').textContent = channelId ? 'Đã kích hoạt kênh có sẵn làm voice trigger.' : 'Đã tạo voice trigger. Member join kênh này sẽ được chuyển sang phòng riêng.';
    toast(channelId ? 'Đã gắn kênh tạo phòng.' : 'Đã tạo voice trigger mới.');
  } catch (error) {
    $('#creatorSetupMessage').textContent = error.message;
    toast(error.message, 'bad');
  } finally { button.disabled = false; }
}

async function loadLiveRooms(force = false) {
  if (!state.guildId || state.liveRoomsLoading) return;
  if (!force && state.liveRoomsLoadedAt && Date.now() - state.liveRoomsLoadedAt < 10_000) {
    renderLiveRooms();
    return;
  }
  state.liveRoomsLoading = true;
  const grid = $('#liveRoomGrid');
  if (!state.liveRooms.length) grid.innerHTML = '<div class="member-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><strong>Đang đồng bộ voice</strong><span>Đang đọc phòng và người đang kết nối.</span></div>';
  try {
    const result = await api(`/api/guilds/${state.guildId}/live-rooms`);
    state.liveRooms = result.rooms || [];
    state.liveRoomsLoadedAt = Date.now();
    $('#liveRoomCount').textContent = state.liveRooms.length;
    $('#liveRoomsTitle').textContent = result.admin ? 'Quản lý tất cả phòng' : 'Phòng của tôi';
    $('#liveRoomsSubtitle').textContent = result.admin ? 'Admin có thể quản lý mọi phòng do bot tạo và thành viên đang ở trong đó.' : 'Bạn chỉ thấy và điều khiển các phòng mình đang là host.';
    const subscription = result.subscription || { premium: false, expiresAt: '', freeEditableLimit: 1 };
    $('#roomPlanStatus').innerHTML = subscription.premium
      ? `<i class="fa-solid fa-crown"></i> Premium${subscription.expiresAt ? ` đến ${new Date(subscription.expiresAt).toLocaleDateString('vi-VN')}` : ''}`
      : `<i class="fa-solid fa-seedling"></i> Free - ${subscription.freeEditableLimit || 1} phòng editable`;
    renderLiveRooms();
  } catch (error) {
    if (!state.liveRooms.length) grid.innerHTML = `<div class="member-empty"><i class="fa-solid fa-triangle-exclamation"></i><strong>Không tải được phòng</strong><span>${esc(error.message)}</span></div>`;
    else toast(error.message, 'bad');
  } finally { state.liveRoomsLoading = false; }
}

function renderLiveRooms() {
  const rooms = state.liveRooms || [];
  $('#liveRoomEmpty').classList.toggle('hidden', rooms.length > 0);
  $('#liveRoomGrid').innerHTML = rooms.map((room) => {
    const members = room.members || [];
    const memberHtml = members.length ? members.map((member) => `<span class="live-member" title="${esc(member.username)}"><span class="member-avatar">${member.avatarUrl ? `<img src="${esc(member.avatarUrl)}" alt="" />` : '<i class="fa-solid fa-user"></i>'}</span><span><strong>${esc(member.displayName)}</strong><small>${member.id === room.ownerId ? 'HOST' : member.bot ? 'BOT' : 'MEMBER'}</small></span></span>`).join('') : '<span class="member-muted">Phòng đang trống.</span>';
    const disabled = room.editable ? '' : 'disabled';
    return `<article class="surface-card live-room-card" data-channel="${esc(room.channelId)}">
      <div class="live-room-head"><div><span class="section-kicker"><i class="fa-solid ${room.editable ? 'fa-sliders' : 'fa-volume-high'}"></i> ${room.editable ? 'EDITABLE ROOM' : 'BASIC ROOM'}</span><h3>${esc(room.name)}</h3><p>Host: <strong>${esc(room.ownerTag)}</strong> - ID ${esc(room.channelId)}</p></div><span class="live-room-state ${room.locked ? 'is-locked' : ''}"><i class="fa-solid ${room.locked ? 'fa-lock' : 'fa-lock-open'}"></i>${room.locked ? 'Đã khóa' : 'Đang mở'}</span></div>
      <div class="live-room-meta"><span><i class="fa-solid fa-users"></i> ${members.length}/${room.userLimit || '∞'}</span><span><i class="fa-solid ${room.hidden ? 'fa-eye-slash' : 'fa-eye'}"></i> ${room.hidden ? 'Đang ẩn' : 'Đang hiện'}</span><span><i class="fa-solid fa-key"></i> ${room.passwordEnabled ? 'Có mật khẩu' : 'Không mật khẩu'}</span><span><i class="fa-solid fa-bell"></i> Log ${room.notifyJoinLeave ? 'bật' : 'tắt'}</span></div>
      <div class="live-member-list">${memberHtml}</div>
      <div class="live-room-actions">
        <button class="button button-light room-web-action" data-action="rename" ${disabled}><i class="fa-solid fa-pen"></i>Đổi tên</button>
        <button class="button button-light room-web-action" data-action="limit" ${disabled}><i class="fa-solid fa-users-gear"></i>Limit</button>
        <button class="button button-light room-web-action" data-action="lock" ${disabled}><i class="fa-solid fa-lock"></i>Khóa/mở</button>
        <button class="button button-light room-web-action" data-action="hide" ${disabled}><i class="fa-solid fa-eye-slash"></i>Ẩn/hiện</button>
        <button class="button button-light room-web-action" data-action="password" ${disabled}><i class="fa-solid fa-key"></i>Password</button>
        <button class="button button-light room-web-action" data-action="invite" ${disabled}><i class="fa-solid fa-user-plus"></i>Mời</button>
        <button class="button button-light room-web-action" data-action="kick" ${disabled}><i class="fa-solid fa-user-minus"></i>Kick</button>
        <button class="button button-light room-web-action" data-action="transfer" ${disabled}><i class="fa-solid fa-crown"></i>Chuyển host</button>
        <button class="button button-light room-web-action" data-action="notifications" ${disabled}><i class="fa-solid fa-bell"></i>Log ra/vào</button>
        <button class="button button-danger room-web-action" data-action="delete"><i class="fa-solid fa-trash"></i>Xóa</button>
      </div>
    </article>`;
  }).join('');
  $$('.room-web-action').forEach((button) => button.addEventListener('click', () => runLiveRoomAction(button.closest('.live-room-card').dataset.channel, button.dataset.action)));
}

function roomMemberPrompt(room, action) {
  const members = (room.members || []).filter((member) => !member.bot && member.id !== room.ownerId);
  const list = members.map((member) => `${member.displayName}: ${member.id}`).join('\n');
  return window.prompt(`${action === 'kick' ? 'Kick' : 'Chuyển host cho'} member nào? Nhập Discord ID.\n${list || 'Hiện không có member phù hợp trong phòng.'}`, members[0]?.id || '');
}

async function runLiveRoomAction(channelId, action) {
  const room = state.liveRooms.find((item) => item.channelId === channelId);
  if (!room) return;
  const body = { action };
  if (action === 'rename') {
    const value = window.prompt('Tên phòng mới', room.name);
    if (!value) return;
    body.value = value;
  } else if (action === 'limit') {
    const value = window.prompt('Giới hạn thành viên (0-99, 0 là không giới hạn)', String(room.userLimit || 0));
    if (value === null) return;
    body.value = Number(value);
  } else if (action === 'password') {
    state.passwordRoomId = channelId;
    $('#roomPasswordValue').value = '';
    $('#roomPasswordDialog').classList.remove('hidden');
    window.setTimeout(() => $('#roomPasswordValue').focus(), 0);
    return;
  } else if (action === 'notifications') {
    body.value = !room.notifyJoinLeave;
  } else if (action === 'invite') {
    const targetUserId = window.prompt('Nhập Discord ID của member muốn mời');
    if (!targetUserId) return;
    body.targetUserId = targetUserId.trim();
  } else if (action === 'kick' || action === 'transfer') {
    const targetUserId = roomMemberPrompt(room, action);
    if (!targetUserId) return;
    body.targetUserId = targetUserId.trim();
  } else if (action === 'delete' && !window.confirm(`Xóa phòng “${room.name}”?`)) return;
  try {
    const result = await api(`/api/guilds/${state.guildId}/live-rooms/${encodeURIComponent(channelId)}/action`, { method: 'POST', body: JSON.stringify(body) });
    toast(result.message || 'Đã cập nhật phòng.');
    await loadLiveRooms(true);
  } catch (error) { toast(error.message, 'bad'); }
}

function closeRoomPasswordDialog() {
  state.passwordRoomId = '';
  $('#roomPasswordValue').value = '';
  $('#roomPasswordDialog').classList.add('hidden');
}

async function saveRoomPassword(event) {
  event.preventDefault();
  const channelId = state.passwordRoomId;
  if (!channelId) return closeRoomPasswordDialog();
  try {
    const result = await api(`/api/guilds/${state.guildId}/live-rooms/${encodeURIComponent(channelId)}/action`, { method: 'POST', body: JSON.stringify({ action: 'password', value: $('#roomPasswordValue').value }) });
    closeRoomPasswordDialog();
    toast(result.message || 'Đã cập nhật mật khẩu.');
    await loadLiveRooms(true);
  } catch (error) { toast(error.message, 'bad'); }
}

function renderStore(products = []) {
  $('#storeProductGrid').innerHTML = products.length ? products.map((product, index) => `<article class="store-card"><span class="store-card-icon"><i class="fa-solid ${index % 2 === 0 ? 'fa-gem' : 'fa-crown'}"></i></span><h3>${esc(product.name)}</h3><p>${esc(product.description || 'Mở quyền Premium cho server.')}</p><strong class="store-price">${vnd(product.priceVnd)}</strong><span class="store-meta"><i class="fa-solid fa-calendar-days"></i> ${product.durationDays ? `${product.durationDays} ngày` : 'Không hết hạn'}</span><button class="button button-dark store-buy" data-id="${esc(product.id)}"><i class="fa-solid fa-qrcode"></i><span>Mua gói</span></button></article>`).join('') : '<div class="member-empty store-empty"><i class="fa-solid fa-store-slash"></i><strong>Chưa có gói Premium</strong><span>Admin chưa mở sản phẩm nào cho server.</span></div>';
  $$('.store-buy').forEach((button) => button.addEventListener('click', () => buyProduct(button.dataset.id)));
}

async function buyProduct(productId) {
  try {
    const result = await api(`/api/public/guilds/${state.guildId}/payment`, { method: 'POST', body: JSON.stringify({ productId }) });
    window.location.href = result.payment.checkoutUrl;
  } catch (error) { toast(error.message, 'bad'); }
}

async function donateFromStore() {
  const amountVnd = Number($('#storeDonationAmount').value.replace(/[^0-9]/g, ''));
  try {
    const result = await api(`/api/public/guilds/${state.guildId}/donation`, { method: 'POST', body: JSON.stringify({ amountVnd, note: $('#storeDonationNote').value.trim() }) });
    window.location.href = result.payment.checkoutUrl;
  } catch (error) { $('#storeMessage').textContent = error.message; toast(error.message, 'bad'); }
}

async function loadMembers(force = false) {
  if (!state.detail?.canManage || state.membersLoading) return;
  if (!force && state.membersLoadedAt && Date.now() - state.membersLoadedAt < 5 * 60_000) {
    renderMembers();
    return;
  }
  if (!force && state.membersRetryAt > Date.now()) return;
  state.membersLoading = true;
  const table = $('#membersTable');
  if (!state.members.length) table.innerHTML = '<div class="member-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><strong>Đang fetch thành viên</strong><span>Discord chỉ được gọi lại khi cache hết hạn hoặc admin bấm Fetch lại.</span></div>';
  try {
    const result = await api(`/api/guilds/${state.guildId}/members${force ? '?refresh=1' : ''}`);
    state.members = result.members || [];
    state.membersLoadedAt = Date.now();
    state.membersRetryAt = 0;
    state.memberPage = 1;
    renderMembers();
  } catch (error) {
    const retrySeconds = Number(String(error.message || '').match(/(?:retry after|sau)\s+([\d.]+)/i)?.[1] || 30);
    state.membersRetryAt = Date.now() + Math.max(5, retrySeconds) * 1000;
    if (state.members.length) {
      renderMembers();
      toast('Không refresh được Discord. Đang dùng member cache gần nhất.', 'bad');
    } else {
      table.innerHTML = `<div class="member-empty"><i class="fa-solid fa-triangle-exclamation"></i><strong>Không fetch được thành viên</strong><span>${esc(error.message)}</span></div>`;
    }
  } finally { state.membersLoading = false; }
}

function renderMembers() {
  const members = state.members || [];
  const search = ($('#memberSearch').value || '').trim().toLowerCase();
  const filtered = members.filter((member) => `${member.displayName} ${member.username} ${member.id}`.toLowerCase().includes(search));
  const premiumCount = members.filter((member) => member.premium).length;
  const paidCount = members.filter((member) => member.paid).length;
  $('#memberTotal').textContent = members.length;
  $('#memberPremium').textContent = premiumCount;
  $('#memberPaid').textContent = paidCount;
  $('#memberPurchaseNote').innerHTML = paidCount ? `<i class="fa-solid fa-circle-check"></i><span>${paidCount} thành viên đã có giao dịch Premium hoặc donate.</span>` : '<i class="fa-solid fa-circle-info"></i><span>Chưa có thành viên nào mua Premium hoặc thanh toán.</span>';
  $('#memberCount').textContent = search ? `${filtered.length} / ${members.length} thành viên` : `${members.length} thành viên`;
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.memberPage = Math.min(totalPages, Math.max(1, state.memberPage));
  const pageMembers = filtered.slice((state.memberPage - 1) * pageSize, state.memberPage * pageSize);
  $('#memberPager').classList.toggle('hidden', totalPages <= 1);
  $('#memberPageLabel').textContent = `Trang ${state.memberPage} / ${totalPages}`;
  $('#memberPrevPage').disabled = state.memberPage <= 1;
  $('#memberNextPage').disabled = state.memberPage >= totalPages;
  if (!filtered.length) {
    $('#memberPager').classList.add('hidden');
    $('#membersTable').innerHTML = `<div class="member-empty"><i class="fa-solid fa-users-slash"></i><strong>${members.length ? 'Không tìm thấy thành viên' : 'Chưa có thành viên nào'}</strong><span>${members.length ? 'Thử đổi từ khóa tìm kiếm.' : 'Bot chưa nhận được member list từ server.'}</span></div>`;
    return;
  }
  $('#membersTable').innerHTML = `<table class="data-table"><thead><tr><th>THÀNH VIÊN</th><th>DISCORD ID</th><th>ROLE</th><th>THANH TOÁN</th><th>TRẠNG THÁI</th><th>THAM GIA</th></tr></thead><tbody>${pageMembers.map((member) => `<tr><td><span class="member-name"><span class="member-avatar">${member.avatarUrl ? `<img src="${esc(member.avatarUrl)}" alt="" loading="lazy" />` : '<i class="fa-solid fa-user"></i>'}</span><span><strong>${esc(member.displayName)}</strong><small class="member-subname">@${esc(member.username)}</small></span></span></td><td class="mono">${esc(member.id)}</td><td>${member.premium ? '<span class="member-role-chip"><i class="fa-solid fa-gem"></i> Premium</span>' : '<span class="member-muted">Thành viên</span>'}</td><td>${member.paid ? `<strong>${vnd(member.payment.paidTotalVnd)}</strong><small class="member-subname">${member.payment.paidCount} giao dịch</small>` : '<span class="member-muted">Chưa thanh toán</span>'}</td><td>${member.paid ? '<span class="status-paid"><i class="fa-solid fa-circle-check"></i> Đã mua</span>' : '<span class="member-muted"><i class="fa-solid fa-circle-minus"></i> Chưa mua</span>'}</td><td>${member.joinedAt ? new Date(member.joinedAt).toLocaleDateString('vi-VN') : 'Không rõ'}</td></tr>`).join('')}</tbody></table>`;
}

function renderProducts(products = []) {
  $('#productCount').textContent = products.length;
  $('#productList').innerHTML = products.length ? products.map((product) => `<div class="product-item"><div class="product-item-head"><strong>${esc(product.name)}</strong><span class="price">${vnd(product.priceVnd)}</span></div><p>${esc(product.description || 'Không có mô tả')} <i class="fa-solid fa-circle"></i> ${product.durationDays ? `${product.durationDays} ngày` : 'Không hết hạn'} <i class="fa-solid fa-circle"></i> <span class="${product.active ? 'status-paid' : 'status-cancelled'}">${product.active ? 'ĐANG BÁN' : 'ĐÃ TẮT'}</span></p><div class="product-actions"><button class="button button-light edit-product" data-id="${esc(product.id)}"><i class="fa-solid fa-pen"></i><span>Sửa</span></button><button class="button button-light delete-product" data-id="${esc(product.id)}"><i class="fa-solid fa-trash"></i><span>Xóa</span></button></div></div>`).join('') : '<div class="inline-empty"><i class="fa-solid fa-gem"></i><span>Chưa có gói Premium.</span></div>';
  $$('.edit-product').forEach((button) => button.addEventListener('click', () => editProduct(button.dataset.id)));
  $$('.delete-product').forEach((button) => button.addEventListener('click', () => deleteProduct(button.dataset.id)));
}

function editProduct(id) {
  const product = state.detail.products.find((item) => item.id === id);
  if (!product) return;
  $('#productFormTitle').textContent = 'Sửa gói';
  $('#cancelProductEdit').classList.remove('hidden');
  $('#productId').value = product.id;
  $('#productName').value = product.name;
  $('#productDescription').value = product.description;
  $('#productPrice').value = product.priceVnd;
  $('#productDuration').value = product.durationDays;
  $('#productRoleId').value = product.roleId;
  $('#productActive').checked = product.active;
  setPage('products');
  $('#productName').focus();
}

function resetProductForm() {
  $('#productForm').reset();
  $('#productFormTitle').textContent = 'Thêm gói mới';
  $('#cancelProductEdit').classList.add('hidden');
  $('#productId').value = '';
  $('#productDuration').value = 30;
  $('#productActive').checked = true;
}

async function saveProduct(event) {
  event.preventDefault();
  const body = { name: $('#productName').value.trim(), description: $('#productDescription').value.trim(), priceVnd: Number($('#productPrice').value.replace(/[^0-9]/g, '')), durationDays: Number($('#productDuration').value || 0), roleId: $('#productRoleId').value.trim(), active: $('#productActive').checked, sortOrder: 0 };
  try {
    const id = $('#productId').value;
    const result = await api(`/api/guilds/${state.guildId}/products${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    state.detail.products = id ? state.detail.products.map((item) => item.id === id ? result.product : item) : [...state.detail.products, result.product];
    renderProducts(state.detail.products);
    resetProductForm();
    renderSetupProgress(state.detail.settings, state.detail.products, state.detail.sepay);
    toast('Đã lưu bảng giá.');
  } catch (error) { $('#productMessage').textContent = error.message; toast(error.message, 'bad'); }
}

async function deleteProduct(id) {
  if (!window.confirm('Xóa gói này?')) return;
  try { await api(`/api/guilds/${state.guildId}/products/${id}`, { method: 'DELETE' }); state.detail.products = state.detail.products.filter((item) => item.id !== id); renderProducts(state.detail.products); toast('Đã xóa gói.'); } catch (error) { toast(error.message, 'bad'); }
}

function paymentStatus(status) {
  const cls = status === 'paid' ? 'status-paid' : status === 'pending' ? 'status-pending' : 'status-cancelled';
  const icon = status === 'paid' ? 'fa-circle-check' : status === 'pending' ? 'fa-clock' : 'fa-circle-xmark';
  return `<span class="${cls}"><i class="fa-solid ${icon}"></i> ${esc(status.toUpperCase())}</span>`;
}

function paymentTable(payments) {
  return `<table class="data-table"><thead><tr><th>NGƯỜI DÙNG</th><th>MÃ ĐƠN</th><th>LOẠI</th><th>SỐ TIỀN</th><th>TRẠNG THÁI</th><th>THỜI GIAN</th></tr></thead><tbody>${payments.map((payment) => `<tr><td><strong>${esc(payment.discordUserTag)}</strong></td><td class="mono">${esc(payment.orderCode)}</td><td><i class="fa-solid ${payment.type === 'donation' ? 'fa-mug-hot' : 'fa-gem'}"></i> ${payment.type === 'donation' ? 'Donate' : 'Premium'}</td><td>${vnd(payment.paidAmountVnd || payment.expectedAmountVnd)}</td><td>${paymentStatus(payment.status)}</td><td>${new Date(payment.createdAt).toLocaleString('vi-VN')}</td></tr>`).join('')}</tbody></table>`;
}

function renderRecentPayments(payments = []) {
  $('#recentPayments').innerHTML = payments.length ? paymentTable(payments.slice(0, 5)) : '<div class="inline-empty"><i class="fa-solid fa-receipt"></i><span>Chưa có giao dịch.</span></div>';
}

async function loadPayments(quiet = false) {
  try {
    const result = await api(`/api/guilds/${state.guildId}/payments?limit=100`);
    state.detail.payments = result.payments;
    renderRecentPayments(result.payments);
    $('#paymentsTable').innerHTML = result.payments.length ? paymentTable(result.payments) : '<div class="inline-empty"><i class="fa-solid fa-receipt"></i><span>Chưa có giao dịch.</span></div>';
    if (!quiet) toast('Đã làm mới payment ledger.');
  } catch (error) { if (!quiet) toast(error.message, 'bad'); }
}

function renderIntegration(sepay, integration) {
  $('#sepayWebhookUrl').value = sepay.webhookUrl;
  $('#paymentsEndpoint').value = integration.paymentsEndpoint;
  $('#entitlementsEndpoint').value = integration.entitlementsEndpoint;
  $('#sepayStatus').innerHTML = sepay.webhookConfigured ? '<i class="fa-solid fa-circle-check"></i> Webhook sẵn sàng' : '<i class="fa-solid fa-triangle-exclamation"></i> Thiếu webhook API key';
  $('#sepayApiStatus').innerHTML = sepay.apiTokenConfigured ? '<i class="fa-solid fa-key"></i> API token đã cấu hình' : '<i class="fa-solid fa-triangle-exclamation"></i> Thiếu API token v2';
  $('#sepayApiMessage').textContent = sepay.apiTokenConfigured ? `Sẵn sàng đối soát qua ${sepay.apiBaseUrl}.` : 'Thêm SEPAY_API_TOKEN vào .env rồi restart service.';
  $('#integrationCode').textContent = `const response = await fetch('${integration.paymentsEndpoint}?guildId=${state.guildId}', {\n  headers: { 'X-SGF-Secret': process.env.SGF_BOT_API_SECRET }\n});\nconst { data: payments } = await response.json();\n\nGET ${integration.entitlementsEndpoint}?guildId=${state.guildId}&discordUserId=DISCORD_ID`;
}

async function checkSepayApi() {
  const button = $('#checkSepayApiButton');
  button.disabled = true;
  $('#sepayApiMessage').textContent = 'Đang kết nối SePay API v2…';
  try {
    const result = await api(`/api/guilds/${state.guildId}/sepay-status?refresh=1`);
    const status = result.status || {};
    $('#sepayApiStatus').innerHTML = status.reachable ? '<i class="fa-solid fa-circle-check"></i> API v2 kết nối tốt' : '<i class="fa-solid fa-triangle-exclamation"></i> API v2 chưa sẵn sàng';
    $('#sepayApiMessage').textContent = status.reachable
      ? `Đã xác thực ${status.accounts?.length || 0} tài khoản ngân hàng: ${(status.accounts || []).map((account) => `${account.bankCode} - ${account.accountNumber}`).join(', ') || 'không có tài khoản active'}.`
      : (status.error || 'Không kết nối được SePay API.');
    toast(status.reachable ? 'Kết nối SePay API v2 thành công.' : 'SePay API chưa sẵn sàng.', status.reachable ? 'good' : 'bad');
  } catch (error) { $('#sepayApiMessage').textContent = error.message; toast(error.message, 'bad'); }
  finally { button.disabled = false; }
}

async function savePaymentSettings() {
  try {
    const result = await api(`/api/guilds/${state.guildId}/settings`, { method: 'PUT', body: JSON.stringify({ bankCode: $('#bankCode').value.trim(), bankAccountNumber: $('#bankAccountNumber').value.trim(), bankAccountName: $('#bankAccountName').value.trim(), donationMinVnd: Number($('#donationMinVnd').value.replace(/[^0-9]/g, '') || 1000), staticQrUrl: $('#staticQrUrl').value.trim() }) });
    state.detail.settings = result.settings;
    fillSettings(result.settings);
    renderSetupProgress(result.settings, state.detail.products, state.detail.sepay);
    toast('Đã lưu thông tin nhận tiền.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function postPanel() {
  if (!state.guildId || !state.detail?.canManage) {
    toast('Hãy chọn server quản trị trước khi đăng payment panel.', 'bad');
    return;
  }
  if (!state.detail.settings.paymentPanelChannelId) {
    toast('Chưa cấu hình Payment panel channel trong mục Voice rooms.', 'bad');
    setPage('voice');
    return;
  }
  try { const result = await api(`/api/guilds/${encodeURIComponent(state.guildId)}/payment-panel`, { method: 'POST' }); toast(result.message); } catch (error) { toast(error.message, 'bad'); }
}

async function refreshGuilds() {
  try { await loadGuilds(); toast('Đã kiểm tra lại server.'); } catch (error) { toast(error.message, 'bad'); }
}

async function init() {
  setupTheme();
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
  $$('[data-go-page]').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.goPage)));
  $('#loginButton').addEventListener('click', () => goLogin());
  $('#heroLogin').addEventListener('click', () => goLogin());
  $('#sidebarLogout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); window.location.reload(); });
  $('#sidebarServerButton').addEventListener('click', showServerPicker);
  $('#changeServerButton').addEventListener('click', showServerPicker);
  $('#serverSearch').addEventListener('input', () => renderGuildCards());
  $('#refreshGuildsButton').addEventListener('click', refreshGuilds);
  $('#inviteBotButton').addEventListener('click', () => { if (state.runtime?.inviteUrl) window.open(state.runtime.inviteUrl, '_blank', 'noopener'); else toast('Chưa có Client ID để tạo invite link.', 'bad'); });
  $('#saveVoiceButton').addEventListener('click', saveVoiceSettings);
  $('#creatorSetupForm').addEventListener('submit', createCreatorChannel);
  $('#productForm').addEventListener('submit', saveProduct);
  $('#cancelProductEdit').addEventListener('click', resetProductForm);
  $('#postPanelButton').addEventListener('click', postPanel);
  $('#refreshPaymentsButton').addEventListener('click', () => loadPayments(false));
  $('#refreshLiveRoomsButton').addEventListener('click', () => loadLiveRooms(true));
  $('#roomPasswordForm').addEventListener('submit', saveRoomPassword);
  $('#cancelRoomPassword').addEventListener('click', closeRoomPasswordDialog);
  $('#roomPasswordDialog').addEventListener('click', (event) => { if (event.target.id === 'roomPasswordDialog') closeRoomPasswordDialog(); });
  $('#savePaymentSettingsButton').addEventListener('click', savePaymentSettings);
  $('#storeDonateButton').addEventListener('click', donateFromStore);
  $('#refreshMembersButton').addEventListener('click', () => loadMembers(true));
  $('#memberSearch').addEventListener('input', () => { state.memberPage = 1; renderMembers(); });
  $('#memberPrevPage').addEventListener('click', () => { state.memberPage -= 1; renderMembers(); });
  $('#memberNextPage').addEventListener('click', () => { state.memberPage += 1; renderMembers(); });
  $('#copyIntegrationButton').addEventListener('click', () => { navigator.clipboard?.writeText($('#integrationCode').textContent); toast('Đã copy API snippet.'); });
  $('#checkSepayApiButton').addEventListener('click', checkSepayApi);

  try {
    const runtime = await api('/api/runtime');
    renderRuntime(runtime);
    const session = await api('/api/session');
    if (!session.authenticated) { showLoggedOut(); return; }
    showAuthenticated(session.user);
    userIcon(session.user);
    await loadGuilds();
    const requestedPage = location.hash.slice(1);
    if (state.guilds.length === 1) await selectGuild(state.guilds[0].id);
    if (requestedPage && pageNames[requestedPage] && state.guildId) setPage(requestedPage);
  } catch (error) {
    toast(error.message, 'bad');
    showLoggedOut();
  }
}

init();
