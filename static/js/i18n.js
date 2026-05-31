// ── i18n ──
const LANG_KEY = 'seq_lang';
let currentLang = localStorage.getItem(LANG_KEY) || 'en';

const STRINGS = {
  en: {
    searchPlaceholder: 'Search for a bus stop…',
    nearbyPlaceholder: 'Nearby stops ↓',
    noStopsFound: 'No stops found',
    fetchingData: 'Fetching real-time data…',
    noUpcomingBuses: 'No upcoming buses found.',
    serviceEnded: "Today's service has ended",
    filterPlatform: 'Platform',
    filterDirection: 'Direction',
    filterRoute: 'Route',
    outbound: 'Outbound',
    inbound: 'Inbound',
    dirEnded: 'Ended',
    timelinePassed: 'Passed',
    timelineUpcoming: 'Upcoming',
    timelineUnavailable: 'Stop timeline unavailable',
    mapHint: '← Select a bus to show its route',
    mapLoading: 'Loading…',
    mapNoShape: 'No shape data for this route',
    mapShapeUnavailable: 'Route shape unavailable',
    gpsYouAreHere: 'You are here',
    gpsNoStops: 'No bus stops found nearby.',
    gpsFetchError: 'Could not fetch nearby stops.',
    gpsAccessDenied: 'Location access denied. Please allow location in your browser.',
    gpsError: 'Could not get your location. Please try again.',
    serverError: 'Could not reach the server. Is FastAPI running?',
    fetchError: 'Could not fetch arrival data. Please try again.',
    tomorrow: 'Tomorrow',
    showMore: n => `＋ Show all ${n} more`,
    nPlatforms: n => `${n} platforms`,
    nStops: n => `${n} stops`,
    alertNone: 'No active service alerts.',
    alertNoneFor: r => `No alerts for ${r}.`,
    inactivityMsg: 'Auto-refresh paused after 30 min of inactivity.',
    inactivityResume: 'Resume',
    sectionFavorites: 'Favorites',
    sectionNextBuses: 'Next buses',
    sectionRouteMap: 'Route map',
    subtitle: 'Real-time arrivals powered by Translink GTFS-RT',
    alertPanelTitle: 'Service Alerts',
    alertBtnLabel: 'Service Alerts',
    alertSortDefault: 'Default',
    alertSortRoute: 'Route',
    alertSortCause: 'Cause',
    alertSortEffect: 'Effect',
    settingsTitle: 'Settings',
    settingsTheme: 'Theme',
    settingsThemeDark: 'Dark',
    settingsThemeLight: 'Light',
    settingsLang: 'Language',
    autoLabel: 'Auto',
    refreshBtnLabel: '↺ Refresh',
    now: 'Now',
    minLabel: 'min',
    platLabel: 'Plat',
    vehicleLive: 'Live position',
    vehicleApproaching: 'Approaching (pre-turnaround)',
    vehicleSecsAgo: s => `${s}s ago`,
    vehicleMinAgo: m => `${m}min ago`,
    vehicleNoPos: 'No live position available',
    vehicleStopsAway: n => n === 1 ? `1 stop away` : `${n} stops away`,
    vehicleAtStop: 'At this stop',
    vehiclePassed: 'Passed this stop',
    vehicleCurrentStop: stop => `At: ${stop}`,
    demoLabel: 'DEMO',
    demoBanner: 'Demo mode — showing timetable from 8:00 AM today',
    tabStop: 'Stop',
    tabRoute: 'Route',
    tabMap: 'Map',
    mapTabHint: 'Search a route number to view its map',
    routeSearchPlaceholder: 'Search by route number…',
    noRoutesFound: 'No routes found',
    routeDir0: 'Outbound',
    routeDir1: 'Inbound',
    rtUnavailable: 'Real-time data unavailable — showing scheduled times only.',
    lastStop: 'Terminates here',
    filterHideTerminates: 'Show terminus',
    timetableGo: 'Go',
    timetableBanner: (date, time) => `Timetable from ${date} ${time}`,
    liveMode: 'Live',
    timetableMode: 'Timetable',
    today: 'Today',
    viewStopTimetable: 'View timetable',
    timetableMorning: 'Morning (before noon)',
    timetableAfternoon: 'Afternoon (12–18)',
    timetableEvening: 'Evening (after 18)',
    noServiceOnDate: 'No service on this date',
  },
  ja: {
    searchPlaceholder: 'バス停を検索…',
    nearbyPlaceholder: '近くのバス停 ↓',
    noStopsFound: 'バス停が見つかりません',
    fetchingData: 'リアルタイムデータ取得中…',
    noUpcomingBuses: '次のバスは見つかりません',
    serviceEnded: '今日のバスは終了しました',
    filterPlatform: 'のりば',
    filterDirection: '方向',
    filterRoute: '路線',
    outbound: '下り',
    inbound: '上り',
    dirEnded: '終了',
    timelinePassed: '通過済み',
    timelineUpcoming: 'これから',
    timelineUnavailable: '停車駅情報を表示できません',
    mapHint: '← バスを選択するとルートを表示',
    mapLoading: '読み込み中…',
    mapNoShape: 'この路線のルートデータがありません',
    mapShapeUnavailable: 'ルートを表示できません',
    gpsYouAreHere: '現在地',
    gpsNoStops: '近くにバス停が見つかりません',
    gpsFetchError: '近くのバス停を取得できませんでした',
    gpsAccessDenied: '位置情報へのアクセスが拒否されました。ブラウザの設定を確認してください。',
    gpsError: '位置情報を取得できませんでした。もう一度お試しください。',
    serverError: 'サーバーに接続できません',
    fetchError: '到着情報を取得できませんでした。もう一度お試しください。',
    tomorrow: '明日',
    showMore: n => `＋ さらに${n}件表示`,
    nPlatforms: n => `${n} のりば`,
    nStops: n => `${n} バス停`,
    alertNone: '現在アクティブなアラートはありません',
    alertNoneFor: r => `${r} のアラートはありません`,
    inactivityMsg: '30分間操作がなかったため、自動更新を停止しました。',
    inactivityResume: '再開',
    sectionFavorites: 'お気に入り',
    sectionNextBuses: '次のバス',
    sectionRouteMap: 'ルートマップ',
    subtitle: 'Translinkリアルタイム情報',
    alertPanelTitle: 'サービス情報',
    alertSortDefault: 'デフォルト',
    alertSortRoute: '路線',
    alertSortCause: '原因',
    alertSortEffect: '影響',
    alertBtnLabel: 'サービス情報',
    settingsTitle: '設定',
    settingsTheme: 'テーマ',
    settingsThemeDark: 'ダーク',
    settingsThemeLight: 'ライト',
    settingsLang: '言語',
    autoLabel: '自動',
    refreshBtnLabel: '↺ 更新',
    now: 'まもなく',
    minLabel: '分',
    platLabel: 'のりば',
    vehicleLive: 'リアルタイム位置',
    vehicleApproaching: '折り返し前の位置',
    vehicleSecsAgo: s => `${s}秒前`,
    vehicleMinAgo: m => `${m}分前`,
    vehicleNoPos: '位置情報なし',
    vehicleStopsAway: n => `あと${n}駅`,
    vehicleAtStop: '停車中',
    vehiclePassed: '通過済み',
    vehicleCurrentStop: stop => `現在地: ${stop}`,
    demoLabel: 'DEMO',
    demoBanner: 'デモモード — 本日 08:00 からの時刻表を表示中',
    tabStop: 'バス停',
    tabRoute: '路線',
    tabMap: 'マップ',
    mapTabHint: '路線番号を検索してマップを表示',
    routeSearchPlaceholder: '路線番号で検索…',
    noRoutesFound: '路線が見つかりません',
    routeDir0: '下り',
    routeDir1: '上り',
    rtUnavailable: 'リアルタイム情報を取得できません。時刻表の予定時刻を表示しています。',
    lastStop: '当駅止まり',
    filterHideTerminates: '終着を表示',
    timetableGo: '表示',
    timetableBanner: (date, time) => `時刻表: ${date} ${time}～`,
    liveMode: 'リアルタイム',
    timetableMode: '時刻表',
    today: '今日',
    viewStopTimetable: '時刻表を見る',
    timetableMorning: '午前（〜12時）',
    timetableAfternoon: '午後（12〜18時）',
    timetableEvening: '夜間（18時〜）',
    noServiceOnDate: 'この日の運行はありません',
  }
};

function t(key, ...args) {
  const s = STRINGS[currentLang]?.[key] ?? STRINGS.en[key];
  if (typeof s === 'function') return s(...args);
  return s ?? key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  const si = document.getElementById('search-input');
  if (si && !si.value) si.placeholder = t('searchPlaceholder');
  const langSw = document.getElementById('settings-lang-switch');
  if (langSw) {
    langSw.classList.toggle('active', currentLang === 'en');
    const val = document.getElementById('settings-lang-val');
    if (val) val.textContent = currentLang === 'en' ? 'English' : '日本語';
  }
  const themeVal = document.getElementById('settings-theme-val');
  if (themeVal) themeVal.textContent = getEffectiveTheme() === 'dark' ? t('settingsThemeDark') : t('settingsThemeLight');
}

function toggleLang() {
  currentLang = currentLang === 'en' ? 'ja' : 'en';
  localStorage.setItem(LANG_KEY, currentLang);
  applyI18n();
  if (currentStopId) {
    renderFilterBar();
    renderArrivals(getFilteredArrivals(), showAllArrivals);
  }
  renderFavorites();
  // Update map hint if showing default
  const hint = document.getElementById('map-hint');
  if (hint && (hint.innerHTML.includes('Select a bus') || hint.innerHTML.includes('バスを選択'))) {
    hint.innerHTML = t('mapHint');
  }
}

