// ── State ──
const API = '';
const M1_COLOR = '#80c242'; // M1 固定カラー
const M2_COLOR = '#5EC4BC'; // M2 固定カラー

// M1/M2 はエンドポイントのカラーを無視して固定色を使う
function resolveRouteColor(routeShort, routeColor) {
  if (routeShort === 'M1') return M1_COLOR;
  if (routeShort === 'M2') return M2_COLOR;
  return routeColor || '';
}

let autoRefreshEnabled = true;
let demoMode = false;
let timetableMode = false;
let timetableDate = null; // 'YYYY-MM-DD'
let timetableTime = null; // 'HH:MM'
let currentStopRoutes = [];
let currentTab = 'stop';
let currentRouteId = null;
let currentRouteDirection = 0;
let currentRouteData = null;
let mapTabRouteData = null;
let mapTabDirection = 0;
let currentStopId = null;  // ターミナルはparent_id、通常停はstop_id
let currentIsTerminal = false;
let currentStopLat = null;
let currentStopLon = null;
let refreshTimer = null;
let _fetchController = null;
let activeCardIndex = null;
let activeArrivalTripId = null;
let showAllArrivals = false;
let activeArrivalFilter = { platform: null, direction: null, route: null };
let showTerminates = false;
let currentIsNameGrouped = false;
let currentGroupedStopIds = [];
const nameGroupedStopMap = {};  // stop_id -> stop_ids[] for name-grouped stops
let stopDirectionMap = {};       // stop_id -> '0' or '1' (majority direction)
let lastArrivals = [];
