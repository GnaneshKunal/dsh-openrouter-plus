/**
 * dsh-openrouter-plus — browser half.
 *
 * Registers the `settings.section` page that appears as its own entry in Settings
 * navigation ("OpenRouter Plus"). The page reads the loopback relay's control API and
 * shows the tier mounts (with copyable base URLs), the weighted cost signal,
 * provider-route creation, and the most recent relayed requests.
 *
 * It also answers the `settings.models.provider-card` seat for the `llm-pi-ai` family:
 * one compact strip per provider row that routes that row through the relay (attach or
 * detach) without touching the settings card's own draft.
 *
 * Contract: docs/ARCHITECTURE.md ("client.js"). Plain browser JavaScript: no JSX, no
 * build step, no imports beyond the host React module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-openrouter-plus',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-openrouter-plus';

    /** Control API served by the relay listener (loopback only). */
    const CONTROL_PREFIX = '/__openrouter-plus';
    const CLIENT_HEADER = 'web';

    /** The relay prefers 8791 and falls forward to the next free port. */
    const DEFAULT_ORIGINS = Object.freeze([
      'http://127.0.0.1:8791',
      'http://127.0.0.1:8792',
      'http://127.0.0.1:8793',
      'http://127.0.0.1:8794',
    ]);
    const POLL_INTERVAL_MS = 3000;
    const STATUS_TIMEOUT_MS = 2500;
    const PROBE_TIMEOUT_MS = 900;
    const COPY_FEEDBACK_MS = 1600;
    const NOTICE_MS = 5000;
    const RECENT_LIMIT = 5;

    /**
     * The adapter family whose Models rows this plugin extends. The Models page
     * dispatches `settings.models.provider-card` with the row's settings namespace as
     * the key, so this constant is both our registration key and our filter.
     */
    const PI_AI_NS = 'llm-pi-ai';

    /** Tier choices the relay accepts for an attached provider (`''` = pass-through). */
    const ATTACH_TIERS = Object.freeze(['', 'auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast']);

    /**
     * Attaching writes our target table first, which makes the Loader re-apply this
     * plugin and restart the listener, so the HTTP response itself can be cut. These
     * are the gaps used while re-reading the truth; an attach whose target already
     * exists is idempotent, which makes the one retry safe.
     */
    const RECONCILE_DELAYS_MS = Object.freeze([350, 450, 550]);
    const MUTATION_TIMEOUT_MS = 6000;

    /** Accepted tiers when the relay has not reported a mount list yet. */
    const TIER_FALLBACK = Object.freeze(['flex', 'scale', 'auto', 'priority', 'fast', 'ultrafast']);
    /** Documented pricing multipliers, used only when metrics have not seen a tier yet. */
    const TIER_MULTIPLIER_FALLBACK = Object.freeze({
      flex: 0.5,
      scale: 1,
      auto: 1,
      default: 1,
      priority: 2,
      fast: 2,
      ultrafast: 4,
    });

    const EXPECTED_ORIGIN = DEFAULT_ORIGINS[0];

    /**
     * Last origin that actually answered. Module scope by design (the factory stays
     * side-effect free): it only saves a reconnect probe when the page remounts.
     */
    let rememberedOrigin = null;

    /* ------------------------------------------------------------------ dictionaries */

    /** English dictionary (key-set source of truth). */
    const en = {
      'nav': 'OpenRouter Plus',
      'card.title': 'OpenRouter Plus',
      'card.regionAria': 'OpenRouter Plus relay',
      'page.intro': 'A loopback relay that pins OpenRouter service tiers. Point a provider route at one of its mounts to send every request with a chosen tier.',

      'common.unknown': 'unknown',
      'common.notAvailable': '—',
      'common.multiplier': '{value}×',
      'common.ms': '{value} ms',
      'common.defaultTier': 'default',
      'common.version': 'v{version}',

      'status.checking': 'Checking relay…',
      'status.online': 'Relay online',
      'status.offline': 'Relay offline',

      'header.relay': 'Relay',
      'header.upstream': 'Upstream',

      'offline.title': 'Relay offline',
      'offline.reason': 'Reason: {message}',
      'offline.expected': 'Expected origin {origin}; fallback ports {ports}.',
      'offline.timeout': 'The relay did not answer within {seconds} s.',
      'offline.noReason': 'no response',
      'offline.retry': 'Retry',
      'offline.hint': 'Start DSH with the dsh-openrouter-plus plugin enabled, then retry.',

      'error.http': 'HTTP {status}',
      'error.fetch': 'Request failed: {message}',
      'error.badStatus': 'The relay returned an unexpected status payload.',
      'error.badTargets': 'The relay returned an unexpected provider-routes payload.',
      'error.badRepair': 'The relay returned an unexpected repair result.',
      'error.render': 'The OpenRouter Plus page failed to render; the rest of Settings still works.',

      'mounts.caption': 'Tier mounts',
      'mounts.hint': "Paste a mount's base URL into a provider route to pin that service tier.",
      'mounts.column.mount': 'Mount',
      'mounts.column.tier': 'Tier',
      'mounts.column.multiplier': 'Multiplier',
      'mounts.column.requests': 'Requests',
      'mounts.column.tokens': 'Tokens',
      'mounts.column.copy': 'Copy base URL',
      'mounts.copy': 'Copy',
      'mounts.copied': 'Copied',
      'mounts.copyFailed': 'Copy failed',
      'mounts.copyAria': 'Copy base URL for {path}',
      'mounts.passthrough': 'pass-through',
      'mounts.empty': 'The relay reported no mount routes.',

      'savings.caption': 'Spend impact',
      'savings.requests': 'Total requests',
      'savings.tokens': 'Total tokens',
      'savings.multiplier': 'Effective multiplier',
      'savings.idle': 'No relayed traffic yet; the effective multiplier appears after the first request.',
      'savings.noTokens':
        'Requests have gone through, but the relay could not read token usage; the multiplier needs token counts.',
      'savings.below':
        'Weighted at {multiplier}: flex traffic bills below the list token price, so the relay is saving tokens.',
      'savings.above': 'Weighted at {multiplier}: priority, fast or ultrafast traffic bills above the list token price.',
      'savings.equal': 'Weighted at {multiplier}: traffic is billing at the default rate.',
      'savings.note':
        'Multipliers are relative token prices. The relay does not know per-model prices, so no currency amount is shown.',

      'providers.caption': 'Provider routes',
      'providers.explain':
        'A created route appears in the model picker as its own provider; removing it here only deletes routes this page created.',
      'providers.loading': 'Loading provider routes…',
      'providers.retry': 'Reload',
      'providers.unavailable': 'Route editing is unavailable: {reason}',
      'providers.unavailableNoReason': 'Route editing is unavailable in this environment.',
      'providers.sourcesCaption': 'Sources',
      'providers.createdCaption': 'Created routes',
      'providers.emptySources': 'No provider sources are configured.',
      'providers.createdEmpty': 'No route has been created from this page yet.',
      'providers.sourceModels': '{api} · {count} models',
      'providers.sourceKey': 'key env: {env}',
      'providers.tierOption': '{tier} · {multiplier}',
      'providers.tierAria': 'Service tier for {name}',
      'providers.routeName': 'Route name: {name}',
      'providers.routeMeta': '{source} · {tier} · {count} models',
      'providers.routeBase': 'Base URL: {url}',
      'providers.create': 'Create route',
      'providers.creating': 'Creating…',
      'providers.createAria': 'Create route {name}',
      'providers.exists': 'Route {name} already exists.',
      'providers.remove': 'Remove',
      'providers.removing': 'Removing…',
      'providers.removeAria': 'Remove route {name}',
      'providers.noticeCreated': 'Created route {name}.',
      'providers.noticeRemoved': 'Removed route {name}.',
      'providers.actionFailed': 'Route change failed: {message}',
      'providers.missingReasoning': 'no effort levels \u00b7 {count} models',
      'providers.repair': 'Add effort levels to {count} models',
      'providers.repairing': 'Adding effort levels\u2026',
      'providers.repairAria': 'Add effort levels to the {count} models missing them',
      'providers.reasoningEvidence': 'Effort levels come from the same model declared elsewhere in your config.',
      'providers.reasoningDefault': 'A configured default map applies effort levels to every model.',
      'providers.reasoningNever': 'Adding effort levels is disabled in settings.',
      'providers.noticeRepaired': 'Added effort levels to {count} models.',
      'providers.noticeRepairedUnresolved': 'Models still needing a hand-written map: {count}.',
      'providers.noticeRepairNoop': 'Every shown model already has effort levels.',
      'providers.noticeRepairUnresolved': 'Nothing could be inferred automatically; models needing a hand-written map: {count}.',

      'strip.groupAria': 'OpenRouter Plus routing for {name}',
      'strip.route': 'Route through OpenRouter Plus',
      'strip.routed': 'Routed via OpenRouter Plus',
      'strip.tierAria': 'Service tier for {name}',
      'strip.tierNone': 'No tier (pass-through)',
      'strip.apply': 'Route requests',
      'strip.applying': 'Routing\u2026',
      'strip.detach': 'Detach',
      'strip.detaching': 'Restoring\u2026',
      'strip.detachAria': 'Detach {name} from OpenRouter Plus',
      'strip.tierHint': 'Tiers only apply to endpoints that accept an OpenAI-style service_tier (OpenRouter itself, and some compatible gateways).',
      'strip.stalled': 'The relay did not confirm the change; reopen this page to retry.',

      'recent.caption': 'Recent requests',
      'recent.hint': 'Newest relayed requests first.',
      'recent.column.tier': 'Tier',
      'recent.column.model': 'Model',
      'recent.column.status': 'Status',
      'recent.column.ms': 'Duration',
      'recent.column.tokens': 'Tokens',
      'recent.empty': 'No request has gone through the relay yet.',
      'recent.stream': 'stream',
      'recent.streamTitle': 'Streamed response',
      'recent.bytesTitle': 'No usage reported; {bytes} bytes transferred',
    };

    /** Simplified Chinese dictionary, complete against the English key set. */
    const zh = {
      'nav': 'OpenRouter Plus',
      'card.title': 'OpenRouter Plus',
      'card.regionAria': 'OpenRouter Plus 中继',
      'page.intro': '固定 OpenRouter 服务等级的本机中继。把提供商路由指向它的挂载点，每个请求就会带上你选择的等级。',

      'common.unknown': '未知',
      'common.notAvailable': '—',
      'common.multiplier': '{value}×',
      'common.ms': '{value} ms',
      'common.defaultTier': '默认',
      'common.version': 'v{version}',

      'status.checking': '正在检测中继…',
      'status.online': '中继在线',
      'status.offline': '中继离线',

      'header.relay': '中继',
      'header.upstream': '上游',

      'offline.title': '中继离线',
      'offline.reason': '原因：{message}',
      'offline.expected': '预期地址 {origin}；备用端口 {ports}。',
      'offline.timeout': '中继在 {seconds} 秒内未响应。',
      'offline.noReason': '无响应',
      'offline.retry': '重试',
      'offline.hint': '请确认 DSH 已启用 dsh-openrouter-plus 插件后重试。',

      'error.http': 'HTTP {status}',
      'error.fetch': '请求失败：{message}',
      'error.badStatus': '中继返回了无法识别的状态数据。',
      'error.badTargets': '中继返回了无法识别的提供商路由数据。',
      'error.badRepair': '中继返回了无法识别的修复结果。',
      'error.render': 'OpenRouter Plus 页面渲染失败；设置的其余部分不受影响。',

      'mounts.caption': '等级挂载点',
      'mounts.hint': '把挂载点的基址粘贴到提供商路由，即可固定该服务等级。',
      'mounts.column.mount': '挂载点',
      'mounts.column.tier': '等级',
      'mounts.column.multiplier': '倍率',
      'mounts.column.requests': '请求数',
      'mounts.column.tokens': 'Token 数',
      'mounts.column.copy': '复制基址',
      'mounts.copy': '复制',
      'mounts.copied': '已复制',
      'mounts.copyFailed': '复制失败',
      'mounts.copyAria': '复制 {path} 的基址',
      'mounts.passthrough': '直通',
      'mounts.empty': '中继未报告任何挂载路由。',

      'savings.caption': '费用影响',
      'savings.requests': '总请求数',
      'savings.tokens': '总 Token 数',
      'savings.multiplier': '加权倍率',
      'savings.idle': '尚无中继流量；首个请求后才会显示加权倍率。',
      'savings.noTokens': '已有请求经过中继，但未读到 token 用量；加权倍率需要 token 计数。',
      'savings.below': '加权为 {multiplier}：flex 流量低于标价计费，中继正在节省 token 成本。',
      'savings.above': '加权为 {multiplier}：priority、fast 或 ultrafast 流量高于标价计费。',
      'savings.equal': '加权为 {multiplier}：流量按默认价格计费。',
      'savings.note': '倍率为相对 token 价格。中继不知道各模型的实际价格，因此不显示金额。',

      'providers.caption': '提供商路由',
      'providers.explain': '创建的路由会作为独立提供商出现在模型选择器中；在此移除只会删除本页面创建的路由。',
      'providers.loading': '正在加载提供商路由…',
      'providers.retry': '重新加载',
      'providers.unavailable': '无法编辑路由：{reason}',
      'providers.unavailableNoReason': '当前环境无法编辑路由。',
      'providers.sourcesCaption': '可用来源',
      'providers.createdCaption': '已创建的路由',
      'providers.emptySources': '尚未配置任何提供商来源。',
      'providers.createdEmpty': '尚未通过此页面创建路由。',
      'providers.sourceModels': '{api} · {count} 个模型',
      'providers.sourceKey': '密钥环境变量：{env}',
      'providers.tierOption': '{tier} · {multiplier}',
      'providers.tierAria': '{name} 的服务等级',
      'providers.routeName': '路由名称：{name}',
      'providers.routeMeta': '{source} · {tier} · {count} 个模型',
      'providers.routeBase': '基址：{url}',
      'providers.create': '创建路由',
      'providers.creating': '正在创建…',
      'providers.createAria': '创建路由 {name}',
      'providers.exists': '路由 {name} 已存在。',
      'providers.remove': '移除',
      'providers.removing': '正在移除…',
      'providers.removeAria': '移除路由 {name}',
      'providers.noticeCreated': '已创建路由 {name}。',
      'providers.noticeRemoved': '已移除路由 {name}。',
      'providers.actionFailed': '路由修改失败：{message}',
      'providers.missingReasoning': '无强度档位 \u00b7 {count} 个模型',
      'providers.repair': '为 {count} 个模型补充强度档位',
      'providers.repairing': '正在补充强度档位\u2026',
      'providers.repairAria': '为缺少强度档位的 {count} 个模型补充强度档位',
      'providers.reasoningEvidence': '强度档位取自配置中其他位置声明的同一模型。',
      'providers.reasoningDefault': '已配置的默认映射会应用到每个模型。',
      'providers.reasoningNever': '设置中已关闭强度档位补充。',
      'providers.noticeRepaired': '已为 {count} 个模型补充强度档位。',
      'providers.noticeRepairedUnresolved': '仍需手写映射的模型：{count} 个。',
      'providers.noticeRepairNoop': '当前显示的模型都已有强度档位。',
      'providers.noticeRepairUnresolved': '无法自动推断；仍需手写映射的模型：{count} 个。',

      'strip.groupAria': '{name} 的 OpenRouter Plus 转发',
      'strip.route': '通过 OpenRouter Plus 转发',
      'strip.routed': '已通过 OpenRouter Plus 转发',
      'strip.tierAria': '{name} 的服务等级',
      'strip.tierNone': '无等级（直通）',
      'strip.apply': '开始转发',
      'strip.applying': '正在转发\u2026',
      'strip.detach': '解除',
      'strip.detaching': '正在恢复\u2026',
      'strip.detachAria': '将 {name} 从 OpenRouter Plus 解除',
      'strip.tierHint': '服务等级只对接受 OpenAI service_tier 的端点生效（如 OpenRouter 本身及部分兼容网关）。',
      'strip.stalled': '中继未确认本次修改；请重新打开此页面后重试。',

      'recent.caption': '最近请求',
      'recent.hint': '按时间倒序显示最近的中继请求。',
      'recent.column.tier': '等级',
      'recent.column.model': '模型',
      'recent.column.status': '状态',
      'recent.column.ms': '耗时',
      'recent.column.tokens': 'Token 数',
      'recent.empty': '中继尚未转发任何请求。',
      'recent.stream': '流式',
      'recent.streamTitle': '流式响应',
      'recent.bytesTitle': '未读取到用量；已传输 {bytes} 字节',
    };

    /* ------------------------------------------------------------------ helpers */

    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    /** A finite number, or null for anything else (never NaN/Infinity in the UI). */
    function finiteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /** A counter value: finite numbers only, defaulting to 0. */
    function countNumber(value) {
      const number = finiteNumber(value);
      return number === null ? 0 : number;
    }

    function stringValue(value) {
      return typeof value === 'string' ? value : '';
    }

    function formatCount(value) {
      const number = finiteNumber(value);
      if (number === null) return '0';
      try {
        return number.toLocaleString();
      } catch (error) {
        return String(number);
      }
    }

    function roundTwo(value) {
      return Math.round(value * 100) / 100;
    }

    function multiplierLabel(t, value) {
      const number = finiteNumber(value);
      if (number === null) return t('common.notAvailable');
      return t('common.multiplier', { value: String(roundTwo(number)) });
    }

    function hostOf(value) {
      const text = stringValue(value).trim();
      if (text === '') return '';
      try {
        const parsed = new URL(text);
        return parsed.host !== '' ? parsed.host : text;
      } catch (error) {
        return text;
      }
    }

    function portOfOrigin(value) {
      try {
        const parsed = new URL(value);
        if (parsed.port !== '') return parsed.port;
        return parsed.protocol === 'https:' ? '443' : '80';
      } catch (error) {
        return '';
      }
    }

    const FALLBACK_PORTS = DEFAULT_ORIGINS.map(portOfOrigin)
      .filter((port) => port !== '')
      .join(', ');

    function joinURL(originText, pathText) {
      const base = stringValue(originText).replace(/\/+$/, '');
      const suffix = stringValue(pathText);
      if (base === '') return suffix;
      if (suffix === '') return base;
      return suffix.charAt(0) === '/' ? base + suffix : base + '/' + suffix;
    }

    /** Local time-of-day for a recent-request entry, or '' when it cannot be parsed. */
    function localTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return '';
      if (value === '') return '';
      try {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        return date.toLocaleTimeString();
      } catch (error) {
        return '';
      }
    }

    function tierMultiplierFor(tier, byTier) {
      if (typeof tier !== 'string' || tier === '') return 1;
      if (isPlainObject(byTier) && isPlainObject(byTier[tier]) && byTier[tier].multiplier !== null) {
        return byTier[tier].multiplier;
      }
      if (Object.prototype.hasOwnProperty.call(TIER_MULTIPLIER_FALLBACK, tier)) {
        return TIER_MULTIPLIER_FALLBACK[tier];
      }
      return null;
    }

    /** Mount table order: cheapest tier first, pass-through last. */
    function compareMounts(left, right) {
      const leftMultiplier = left.multiplier === null ? Number.POSITIVE_INFINITY : left.multiplier;
      const rightMultiplier = right.multiplier === null ? Number.POSITIVE_INFINITY : right.multiplier;
      if (leftMultiplier !== rightMultiplier) {
        return leftMultiplier - rightMultiplier;
      }
      const leftTier = left.tier === null ? '\uFFFF' : left.tier;
      const rightTier = right.tier === null ? '\uFFFF' : right.tier;
      if (leftTier !== rightTier) return leftTier < rightTier ? -1 : 1;
      if (left.path === right.path) return 0;
      return left.path < right.path ? -1 : 1;
    }

    /** Unique tier names from the relay mounts, in mount-table order. */
    function tiersFromMounts(mounts) {
      const seen = Object.create(null);
      const tiers = [];
      for (const mount of mounts) {
        if (mount.tier === null || seen[mount.tier] === true) continue;
        seen[mount.tier] = true;
        tiers.push(mount.tier);
      }
      return tiers.length > 0 ? tiers : TIER_FALLBACK.slice();
    }

    function defaultTierFor(source, tiers) {
      if (source.attachedTier !== null && tiers.indexOf(source.attachedTier) >= 0) return source.attachedTier;
      if (tiers.indexOf('flex') >= 0) return 'flex';
      return tiers.length > 0 ? tiers[0] : 'flex';
    }

    function proposedRouteName(sourceKey, tier) {
      return sourceKey + '-' + tier;
    }

    function errorMessage(t, error) {
      if (error && error.name === 'AbortError') {
        return t('offline.timeout', { seconds: String(STATUS_TIMEOUT_MS / 1000) });
      }
      if (error && typeof error.message === 'string' && error.message.trim() !== '') {
        return error.message.trim();
      }
      return t('offline.noReason');
    }

    function payloadErrorMessage(payload) {
      if (isPlainObject(payload) && isPlainObject(payload.error)) {
        const message = stringValue(payload.error.message).trim();
        if (message !== '') return message;
      }
      return '';
    }

    function httpError(t, status) {
      return new Error(t('error.http', { status: String(status) }));
    }

    /** A JSON body, or null when the response carried none (a reload can cut it). */
    function readJsonSafe(response) {
      try {
        return response.json();
      } catch (error) {
        return Promise.resolve(null);
      }
    }

    /** Resolve after `ms`, or as soon as `signal` aborts (unmount tears waits down). */
    function sleepUntil(ms, signal) {
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (signal === undefined || signal === null) return;
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    /** A trimmed absolute http(s) URL, or '' when the value is not usable as one. */
    function absoluteHttpURL(value) {
      const text = stringValue(value).trim();
      if (text === '') return '';
      try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        if (parsed.hostname === '') return '';
        return text;
      } catch (error) {
        return '';
      }
    }

    /** The `/targets` source row for one provider route, or null. */
    function providerSourceOf(data, route) {
      if (!isPlainObject(data) || !Array.isArray(data.sources)) return null;
      for (const entry of data.sources) {
        if (isPlainObject(entry) && entry.key === route) return entry;
      }
      return null;
    }

    /**
     * The target this card attached to a provider route, or null. The route link is
     * derived by the relay; matching the source's base URL is the fallback for a
     * payload that predates `route`.
     */
    function relayTargetOf(data, route) {
      if (!isPlainObject(data) || !Array.isArray(data.custom) || route === '') return null;
      for (const entry of data.custom) {
        if (isPlainObject(entry) && entry.id !== '' && entry.route === route) return entry;
      }
      const source = providerSourceOf(data, route);
      if (source === null || source.baseURL === '') return null;
      for (const entry of data.custom) {
        if (isPlainObject(entry) && entry.id !== '' && entry.baseURL === source.baseURL) return entry;
      }
      return null;
    }

    /**
     * A relay-backed route that has no target of ours (a route created by this page),
     * as `{ tier }`, or null. Those rows have nothing to detach: removing the route on
     * the OpenRouter Plus page is the inverse.
     */
    function relayRouteOf(data, route) {
      const source = providerSourceOf(data, route);
      if (source !== null && source.attachedTier !== null) return { tier: source.attachedTier };
      if (isPlainObject(data) && Array.isArray(data.created)) {
        for (const entry of data.created) {
          if (isPlainObject(entry) && entry.name === route) return { tier: entry.tier };
        }
      }
      return null;
    }

    /* ------------------------------------------------------------------ normalizers */

    function normalizeRecent(rawEntry) {
      if (!isPlainObject(rawEntry)) return null;
      const prompt = finiteNumber(rawEntry.promptTokens);
      const completion = finiteNumber(rawEntry.completionTokens);
      let tokens = null;
      if (prompt !== null || completion !== null) {
        tokens = (prompt === null ? 0 : prompt) + (completion === null ? 0 : completion);
      }
      const at = typeof rawEntry.at === 'string' || typeof rawEntry.at === 'number' ? rawEntry.at : '';
      const tier = stringValue(rawEntry.tier).trim();
      const statusNumber = finiteNumber(rawEntry.status);
      const statusText = stringValue(rawEntry.status).trim();
      return {
        at,
        tier: tier === '' ? null : tier,
        model: stringValue(rawEntry.model).trim(),
        streaming: rawEntry.streaming === true,
        status: statusNumber !== null ? statusNumber : statusText === '' ? null : statusText,
        ms: finiteNumber(rawEntry.ms),
        bytes: finiteNumber(rawEntry.bytes),
        tokens,
      };
    }

    function normalizeMounts(rawRoutes, byTier) {
      const mounts = [];
      const seen = Object.create(null);

      const push = (rawPath, rawTier) => {
        const path = stringValue(rawPath).trim();
        if (path === '' || seen[path] === true) return;
        seen[path] = true;
        const tierText = stringValue(rawTier).trim();
        const tier = tierText === '' ? null : tierText;
        let stats = null;
        if (tier === null) {
          stats = isPlainObject(byTier.default) ? byTier.default : null;
        } else if (isPlainObject(byTier[tier])) {
          stats = byTier[tier];
        }
        let multiplier = null;
        if (tier === null) multiplier = 1;
        else if (stats !== null && stats.multiplier !== null) multiplier = stats.multiplier;
        else if (hasOwn(TIER_MULTIPLIER_FALLBACK, tier)) multiplier = TIER_MULTIPLIER_FALLBACK[tier];
        mounts.push({
          path,
          tier,
          multiplier,
          requests: stats === null ? 0 : stats.requests,
          promptTokens: stats === null ? 0 : stats.promptTokens,
          completionTokens: stats === null ? 0 : stats.completionTokens,
        });
      };

      if (Array.isArray(rawRoutes)) {
        for (const entry of rawRoutes) {
          if (typeof entry === 'string') {
            push(entry, null);
            continue;
          }
          if (!isPlainObject(entry)) continue;
          let path = entry.path;
          if (path === undefined) path = entry.mount;
          if (path === undefined) path = entry.prefix;
          if (path === undefined) path = entry.route;
          push(path, entry.tier === undefined ? null : entry.tier);
        }
      } else if (isPlainObject(rawRoutes)) {
        for (const path of Object.keys(rawRoutes)) {
          const value = rawRoutes[path];
          if (isPlainObject(value)) push(path, value.tier === undefined ? null : value.tier);
          else push(path, value);
        }
      }

      mounts.sort(compareMounts);
      return mounts;
    }

    /**
     * Validate the `/status` payload. Returns null for an unexpected shape, which makes
     * the page render its error/offline state instead of throwing inside the slot.
     */
    function normalizeStatusPayload(payload) {
      if (!isPlainObject(payload)) return null;
      if (payload.ok === false) return null;
      if (!isPlainObject(payload.metrics)) return null;

      const byTierSource = isPlainObject(payload.metrics.byTier) ? payload.metrics.byTier : {};
      const byTier = {};
      for (const key of Object.keys(byTierSource)) {
        const entry = byTierSource[key];
        if (!isPlainObject(entry)) continue;
        byTier[key] = {
          requests: countNumber(entry.requests),
          promptTokens: countNumber(entry.promptTokens),
          completionTokens: countNumber(entry.completionTokens),
          multiplier: finiteNumber(entry.multiplier),
          effectiveTokens: countNumber(entry.effectiveTokens),
        };
      }

      const recent = [];
      const recentSource = Array.isArray(payload.metrics.recent) ? payload.metrics.recent : [];
      for (const entry of recentSource) {
        if (recent.length >= RECENT_LIMIT) break;
        const normalized = normalizeRecent(entry);
        if (normalized !== null) recent.push(normalized);
      }

      const address = isPlainObject(payload.address) ? payload.address : {};
      return {
        version: stringValue(payload.version).trim(),
        origin: stringValue(address.origin).trim(),
        upstream: stringValue(payload.upstream).trim(),
        mounts: normalizeMounts(payload.routes, byTier),
        metrics: {
          startedAt: stringValue(payload.metrics.startedAt),
          requests: countNumber(payload.metrics.requests),
          errors: countNumber(payload.metrics.errors),
          streamingRequests: countNumber(payload.metrics.streamingRequests),
          promptTokens: countNumber(payload.metrics.promptTokens),
          completionTokens: countNumber(payload.metrics.completionTokens),
          bytes: countNumber(payload.metrics.bytes),
          byTier,
          effectiveMultiplier: finiteNumber(payload.metrics.effectiveMultiplier),
          recent,
        },
      };
    }

    /** Validate the `/targets` payload; null means an unexpected shape. */
    function normalizeTargets(payload) {
      if (!isPlainObject(payload)) return null;

      const sources = [];
      if (Array.isArray(payload.sources)) {
        for (const entry of payload.sources) {
          if (!isPlainObject(entry)) continue;
          const key = stringValue(entry.key).trim();
          if (key === '') continue;
          const attachedTier = stringValue(entry.attachedTier).trim();
          sources.push({
            key,
            displayName: stringValue(entry.displayName).trim() || key,
            api: stringValue(entry.api).trim(),
            apiKeyEnv: stringValue(entry.apiKeyEnv).trim(),
            baseURL: stringValue(entry.baseURL).trim(),
            modelCount: countNumber(entry.modelCount),
            attachedTier: attachedTier === '' ? null : attachedTier,
          });
        }
      }

      const created = [];
      if (Array.isArray(payload.created)) {
        for (const entry of payload.created) {
          if (!isPlainObject(entry)) continue;
          const name = stringValue(entry.name).trim();
          if (name === '') continue;
          const tier = stringValue(entry.tier).trim();
          created.push({
            name,
            source: stringValue(entry.source).trim(),
            tier: tier === '' ? null : tier,
            baseURL: stringValue(entry.baseURL).trim(),
            modelCount: countNumber(entry.modelCount),
            // Models on this route the composer cannot offer an effort selector
            // for. Zero is the calm case and renders no hint at all.
            missingReasoning: countNumber(entry.missingReasoning),
          });
        }
      }

      /* Targets this card attached to a provider row. `route` names the row that
         currently points here, when one does; `id` is what detach needs. */
      const custom = [];
      if (Array.isArray(payload.custom)) {
        for (const entry of payload.custom) {
          if (!isPlainObject(entry)) continue;
          const id = stringValue(entry.id).trim();
          if (id === '') continue;
          const tier = stringValue(entry.tier).trim();
          custom.push({
            id,
            upstream: stringValue(entry.upstream).trim(),
            tier: tier === '' ? null : tier,
            mount: stringValue(entry.mount).trim(),
            baseURL: stringValue(entry.baseURL).trim(),
            route: stringValue(entry.route).trim(),
          });
        }
      }

      let reasoning = null;
      if (isPlainObject(payload.reasoning)) {
        const fill = stringValue(payload.reasoning.fill).trim();
        if (fill === 'never' || fill === 'evidence' || fill === 'default') {
          const levels = [];
          if (Array.isArray(payload.reasoning.levels)) {
            for (const level of payload.reasoning.levels) {
              const name = stringValue(level).trim();
              if (name !== '') levels.push(name);
            }
          }
          reasoning = { fill: fill, levels: levels };
        }
      }

      return {
        available: payload.available !== false,
        reason: stringValue(payload.reason).trim(),
        sources,
        created,
        custom,
        reasoning,
      };
    }

    /** Validate the `/routes/repair` payload; null means an unexpected shape. */
    function normalizeRepairPayload(payload) {
      if (!isPlainObject(payload)) return null;
      if (!Array.isArray(payload.patched) || !Array.isArray(payload.unresolved)) return null;
      let models = 0;
      for (const entry of payload.patched) {
        if (!isPlainObject(entry)) continue;
        if (Array.isArray(entry.models)) models += entry.models.length;
      }
      return {
        changed: payload.changed === true,
        models: models,
        unresolved: payload.unresolved.length,
      };
    }

    /* ------------------------------------------------------------------ clipboard */

    /* The GUI runs in a secure context (loopback is treated as trustworthy), so the async
       Clipboard API is available. Deliberately no textarea/execCommand fallback: this page
       must not add or move nodes outside its own subtree. When the write is unavailable or
       refused, the caller renders a "could not copy" state instead of failing silently. */
    function writeClipboard(text) {
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          return navigator.clipboard.writeText(text).then(
            () => true,
            () => false,
          );
        }
      } catch (error) {
        return Promise.resolve(false);
      }
      return Promise.resolve(false);
    }

    /* ------------------------------------------------------------------ styles */

    /* Theme tokens only, each with a plain CSS fallback so the page still reads well if
       a token is renamed upstream. Inline styles only: no global CSS, no class names. */

    const COLORS = {
      primary: 'var(--dsw-alias-label-primary, CanvasText)',
      secondary: 'var(--dsw-alias-label-secondary, GrayText)',
      tertiary: 'var(--dsw-alias-label-tertiary, GrayText)',
      border: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2))',
      layerTwo: 'var(--dsw-alias-bg-layer-2, ButtonFace)',
      success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      error: 'var(--dsw-alias-state-error-primary, #c92a2a)',
      warn: 'var(--dsw-alias-state-warn-primary, #b08800)',
      brand: 'var(--dsw-alias-brand-primary, Highlight)',
      fill: 'var(--dsw-alias-fill-l1, rgba(0, 0, 0, 0.06))',
    };

    const FONTS = {
      body: 'var(--dsw-font-xs-13, 400 13px/1.5 system-ui, sans-serif)',
      strong: 'var(--dsw-font-xs-strong-13, 600 13px/1.5 system-ui, sans-serif)',
      small: 'var(--dsw-font-xxs-12, 400 12px/1.5 system-ui, sans-serif)',
      smallStrong: 'var(--dsw-font-xxs-strong-12, 600 12px/1.5 system-ui, sans-serif)',
      tiny: 'var(--dsw-font-xxxs-11, 400 11px/1.45 system-ui, sans-serif)',
      metric: 'var(--dsw-font-base-strong-16, 600 16px/1.4 system-ui, sans-serif)',
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    };

    const visuallyHidden = {
      position: 'absolute',
      width: '1px',
      height: '1px',
      margin: '-1px',
      padding: 0,
      border: 0,
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    };

    const codeStyle = {
      font: FONTS.small,
      fontFamily: FONTS.mono,
      color: COLORS.primary,
      overflowWrap: 'anywhere',
    };

    const mutedCodeStyle = {
      font: FONTS.tiny,
      fontFamily: FONTS.mono,
      color: COLORS.secondary,
      overflowWrap: 'anywhere',
    };

    /*
     * Page layout follows the shipped settings pages: one 720px column, 12px gaps, the
     * panel supplies the background (a card border here would draw a box inside a box).
     */
    const PAGE_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      minWidth: 0,
      maxWidth: '720px',
      boxSizing: 'border-box',
      color: COLORS.primary,
      font: FONTS.body,
      textAlign: 'left',
    };

    const HEADER_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      minWidth: 0,
      paddingBottom: '12px',
    };

    const HEADER_ROW_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px 8px',
      minWidth: 0,
    };

    /* Matches the section titles the settings shell renders: 16/24, medium. */
    const TITLE_STYLE = { fontSize: 16, fontWeight: 500, lineHeight: '24px', margin: 0, color: COLORS.primary };

    /* The one-line description under the title, same size and tone as a shipped section intro. */
    const INTRO_STYLE = { margin: 0, fontSize: 14, lineHeight: '22px', color: COLORS.tertiary };

    const STATUS_TEXT_STYLE = { font: FONTS.small, color: COLORS.secondary };

    const META_ROW_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 14px',
      minWidth: 0,
      color: COLORS.secondary,
      font: FONTS.small,
    };

    const META_ITEM_STYLE = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '6px',
      minWidth: 0,
    };

    const META_LABEL_STYLE = { color: COLORS.secondary, font: FONTS.tiny, whiteSpace: 'nowrap' };

    const TABLE_STYLE = {
      width: '100%',
      maxWidth: '100%',
      borderCollapse: 'collapse',
      tableLayout: 'auto',
    };

    const CAPTION_STYLE = {
      captionSide: 'top',
      textAlign: 'left',
      padding: '0 0 6px',
      color: COLORS.primary,
      font: FONTS.strong,
    };

    const CAPTION_HINT_STYLE = {
      display: 'block',
      marginTop: '2px',
      color: COLORS.secondary,
      font: FONTS.tiny,
      fontWeight: 400,
    };

    const TH_STYLE = {
      padding: '4px 8px 4px 0',
      borderBottom: '1px solid ' + COLORS.border,
      color: COLORS.secondary,
      font: FONTS.small,
      fontWeight: 400,
      textAlign: 'left',
      whiteSpace: 'nowrap',
      verticalAlign: 'bottom',
    };

    const TH_RIGHT_STYLE = {
      padding: '4px 0 4px 8px',
      borderBottom: '1px solid ' + COLORS.border,
      color: COLORS.secondary,
      font: FONTS.small,
      fontWeight: 400,
      textAlign: 'right',
      whiteSpace: 'nowrap',
      verticalAlign: 'bottom',
    };

    const TD_STYLE = {
      padding: '6px 8px 6px 0',
      borderBottom: '1px solid ' + COLORS.border,
      color: COLORS.primary,
      fontVariantNumeric: 'tabular-nums',
      verticalAlign: 'top',
    };

    const TD_RIGHT_STYLE = {
      padding: '6px 0 6px 8px',
      borderBottom: '1px solid ' + COLORS.border,
      color: COLORS.primary,
      fontVariantNumeric: 'tabular-nums',
      textAlign: 'right',
      verticalAlign: 'top',
      whiteSpace: 'nowrap',
    };

    const BADGE_STYLE = {
      display: 'inline-block',
      padding: '0 6px',
      border: '1px solid ' + COLORS.border,
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: COLORS.fill,
      color: COLORS.secondary,
      font: FONTS.tiny,
      whiteSpace: 'nowrap',
    };

    const PARAGRAPH_STYLE = { margin: 0, color: COLORS.primary, font: FONTS.body };

    const HINT_STYLE = { margin: 0, color: COLORS.secondary, font: FONTS.small };

    const H4_STYLE = { margin: 0, color: COLORS.primary, font: FONTS.strong };

    const SUB_LABEL_STYLE = { color: COLORS.secondary, font: FONTS.smallStrong };

    const STATS_ROW_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px 24px',
      minWidth: 0,
    };

    const STAT_STYLE = { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 };

    const STAT_LABEL_STYLE = { color: COLORS.secondary, font: FONTS.tiny };

    const ROW_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '6px 12px',
      minWidth: 0,
      padding: '6px 0',
      borderTop: '1px solid ' + COLORS.border,
    };

    const ROW_INFO_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      flex: '1 1 220px',
      minWidth: 0,
    };

    const ROW_CONTROL_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
    };

    const ALERT_STYLE = {
      margin: 0,
      color: COLORS.error,
      font: FONTS.small,
      overflowWrap: 'anywhere',
    };

    const NOTICE_STYLE = { margin: 0, color: COLORS.secondary, font: FONTS.small };

    const WARN_HINT_STYLE = { margin: 0, color: COLORS.warn, font: FONTS.small };

    const REPAIR_ROW_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 12px',
      minWidth: 0,
      paddingTop: '8px',
      marginTop: '2px',
      borderTop: '1px solid ' + COLORS.border,
    };

    /* Provider-row strip: compact enough to sit between a row head and its editor. */
    const STRIP_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 10px',
      minWidth: 0,
      margin: '2px 0 8px',
      color: COLORS.secondary,
      font: FONTS.small,
    };

    const STRIP_LABEL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      color: COLORS.primary,
      font: FONTS.small,
      cursor: 'pointer',
    };

    const STRIP_STATUS_STYLE = {
      display: 'inline-flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      color: COLORS.secondary,
      font: FONTS.small,
    };

    const STRIP_CHOOSER_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px 10px',
      flex: '1 0 100%',
      minWidth: 0,
      paddingTop: '6px',
      borderTop: '1px solid ' + COLORS.border,
    };

    const STRIP_HINT_STYLE = { margin: 0, flexBasis: '100%', color: COLORS.secondary, font: FONTS.tiny };

    function dotStyle(connection) {
      const color =
        connection === 'online'
          ? COLORS.success
          : connection === 'offline'
            ? COLORS.error
            : COLORS.warn;
      return {
        display: 'inline-block',
        flex: '0 0 auto',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
      };
    }

    function sectionStyle() {
      return {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: 0,
        paddingTop: '12px',
        borderTop: '1px solid ' + COLORS.border,
      };
    }

    function buttonStyle(state) {
      const disabled = state.disabled === true;
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 0,
        padding: '3px 10px',
        minHeight: '24px',
        boxSizing: 'border-box',
        border: '1px solid ' + COLORS.borderStrong,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background:
          state.hovered && !disabled ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))' : COLORS.layerTwo,
        color: COLORS.primary,
        font: FONTS.small,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        outline: state.focused ? '2px solid ' + COLORS.brand : 'none',
        outlineOffset: '2px',
        appearance: 'none',
        WebkitAppearance: 'none',
      };
    }

    function selectStyle(state) {
      const disabled = state.disabled === true;
      return {
        margin: 0,
        padding: '2px 6px',
        minHeight: '24px',
        boxSizing: 'border-box',
        border: '1px solid ' + COLORS.borderStrong,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: COLORS.layerTwo,
        color: COLORS.primary,
        font: FONTS.small,
        lineHeight: '18px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        outline: state.focused ? '2px solid ' + COLORS.brand : 'none',
        outlineOffset: '2px',
      };
    }

    /* ------------------------------------------------------------------ components */

    /**
     * Error boundary around the whole page. The host also guards slot entries, but this
     * boundary keeps any render failure inside the page and shows a localized note.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error, info) {
        try {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[dsh-openrouter-plus] settings page render failed', error, info);
          }
        } catch (ignored) {
          /* logging must never throw out of an error boundary */
        }
      }

      render() {
        if (this.state.failed !== true) return this.props.children;
        const t = this.props.t;
        return h(
          'section',
          { 'aria-label': t('card.regionAria'), style: PAGE_STYLE },
          h('h2', { style: TITLE_STYLE }, t('card.title')),
          h('p', { role: 'alert', style: ALERT_STYLE }, t('error.render')),
        );
      }
    }

    /** Secondary-style button with a real focus outline (inline styles cannot use :focus). */
    function ActionButton(props) {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      const disabled = props.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          title: props.title,
          'aria-label': props.ariaLabel,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: buttonStyle({ hovered: hovered, focused: focused, disabled: disabled }),
        },
        props.label,
      );
    }

    /** Native select styled like the page's secondary controls. */
    function TierSelect(props) {
      const [focused, setFocused] = React.useState(false);
      const disabled = props.disabled === true;
      return h(
        'select',
        {
          value: props.value,
          disabled: disabled,
          'aria-label': props.ariaLabel,
          onChange: (event) => {
            if (!disabled) props.onChange(event.target.value);
          },
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: selectStyle({ focused: focused, disabled: disabled }),
        },
        props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      );
    }

    /**
     * The page body. Everything stateful lives here so the slot wrapper stays trivial and
     * unmounting the slot tears down every timer, fetch and listener this page owns.
     */
    function PageBody(props) {
      const t = props.t;

      const [origin, setOrigin] = React.useState(() =>
        rememberedOrigin !== null ? rememberedOrigin : DEFAULT_ORIGINS[0],
      );
      const [connection, setConnection] = React.useState('checking');
      const [snapshot, setSnapshot] = React.useState(null);
      const [statusError, setStatusError] = React.useState('');
      const [refreshKey, setRefreshKey] = React.useState(0);
      const [targets, setTargets] = React.useState({ status: 'idle', data: null, error: '' });
      const [targetsKey, setTargetsKey] = React.useState(0);
      const [tierChoices, setTierChoices] = React.useState({});
      const [busy, setBusy] = React.useState(null);
      const [actionError, setActionError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [copyState, setCopyState] = React.useState(null);

      const mountedRef = React.useRef(true);
      const busyRef = React.useRef(null);
      const actionControllerRef = React.useRef(null);
      const noticeTimerRef = React.useRef(null);
      const copyTimerRef = React.useRef(null);

      /* Track mount state and clear every owned timer/request on unmount. */
      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        return () => {
          busyRef.current = null;
          if (actionControllerRef.current !== null) {
            try {
              actionControllerRef.current.abort();
            } catch (error) {
              /* already settled */
            }
            actionControllerRef.current = null;
          }
          if (noticeTimerRef.current !== null) {
            clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = null;
          }
          if (copyTimerRef.current !== null) {
            clearTimeout(copyTimerRef.current);
            copyTimerRef.current = null;
          }
        };
      }, []);

      /*
       * Status polling: one request, then a chained setTimeout (never setInterval) so a
       * slow relay cannot queue overlapping probes. A failed status fetch probes the
       * documented fallback ports via /health; when a different port answers, the page
       * switches origin and this effect re-runs immediately at the new origin.
       */
      React.useEffect(() => {
        let cancelled = false;
        let pollTimer = null;
        const controllers = new Set();

        const abortAll = () => {
          for (const controller of controllers) {
            try {
              controller.abort();
            } catch (error) {
              /* already settled */
            }
          }
          controllers.clear();
        };

        const request = async (url, timeoutMs, init) => {
          const controller = new AbortController();
          controllers.add(controller);
          let timeoutTimer = null;
          try {
            timeoutTimer = setTimeout(() => {
              try {
                controller.abort();
              } catch (error) {
                /* already settled */
              }
            }, timeoutMs);
            return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
          } finally {
            if (timeoutTimer !== null) clearTimeout(timeoutTimer);
            controllers.delete(controller);
          }
        };

        const readJson = async (response) => {
          try {
            return await response.json();
          } catch (error) {
            return null;
          }
        };

        const schedule = (delay) => {
          if (cancelled) return;
          if (pollTimer !== null) clearTimeout(pollTimer);
          pollTimer = setTimeout(() => {
            pollTimer = null;
            tick();
          }, delay);
        };

        const loadStatus = async (target) => {
          const response = await request(target + CONTROL_PREFIX + '/status', STATUS_TIMEOUT_MS, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw httpError(t, response.status);
          const payload = await readJson(response);
          const normalized = normalizeStatusPayload(payload);
          if (normalized === null) {
            /* The relay reports its own startup/route failures as `ok: false` plus an
               `error` string; surface that instead of the generic shape complaint. */
            const relayError =
              isPlainObject(payload) && payload.ok === false ? stringValue(payload.error).trim() : '';
            throw new Error(relayError === '' ? t('error.badStatus') : relayError);
          }
          return normalized;
        };

        const probeOrigin = async () => {
          for (const candidate of DEFAULT_ORIGINS) {
            if (cancelled) return null;
            try {
              const response = await request(candidate + CONTROL_PREFIX + '/health', PROBE_TIMEOUT_MS, {
                method: 'GET',
                mode: 'cors',
                cache: 'no-store',
                headers: { accept: 'application/json' },
              });
              if (!response.ok) continue;
              const payload = await readJson(response);
              if (isPlainObject(payload) && payload.ok !== false) return candidate;
            } catch (error) {
              if (cancelled) return null;
            }
          }
          return null;
        };

        const tick = async () => {
          if (cancelled) return;
          try {
            const normalized = await loadStatus(origin);
            if (cancelled) return;
            rememberedOrigin = origin;
            setSnapshot(normalized);
            setStatusError('');
            setConnection('online');
          } catch (error) {
            if (cancelled) return;
            const reason = errorMessage(t, error);
            const alternate = await probeOrigin();
            if (cancelled) return;
            if (alternate !== null && alternate !== origin) {
              rememberedOrigin = alternate;
              setSnapshot(null);
              setStatusError('');
              setConnection('checking');
              setOrigin(alternate);
              return;
            }
            setSnapshot(null);
            setStatusError(reason);
            setConnection('offline');
          }
          schedule(POLL_INTERVAL_MS);
        };

        schedule(0);

        return () => {
          cancelled = true;
          if (pollTimer !== null) clearTimeout(pollTimer);
          pollTimer = null;
          abortAll();
        };
      }, [origin, refreshKey, t]);

      /* Provider routes load once the relay is online and refresh after every mutation. */
      React.useEffect(() => {
        if (connection !== 'online') return undefined;
        let cancelled = false;
        const controller = new AbortController();
        setTargets((previous) => ({
          status: previous.data !== null ? 'refreshing' : 'loading',
          data: previous.data,
          error: '',
        }));
        (async () => {
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/targets', {
              method: 'GET',
              mode: 'cors',
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: controller.signal,
            });
            if (!response.ok) throw httpError(t, response.status);
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            const normalized = normalizeTargets(payload);
            if (normalized === null) throw new Error(t('error.badTargets'));
            if (cancelled) return;
            setTargets({ status: 'ready', data: normalized, error: '' });
          } catch (error) {
            if (cancelled) return;
            if (error && error.name === 'AbortError') return;
            setTargets({ status: 'error', data: null, error: errorMessage(t, error) });
          }
        })();
        return () => {
          cancelled = true;
          try {
            controller.abort();
          } catch (error) {
            /* already settled */
          }
        };
      }, [connection, origin, targetsKey, t]);

      const runRouteAction = (kind, body, successKey, successName) => {
        if (busy !== null || busyRef.current !== null) return;
        const busyKey = body.name !== undefined ? String(body.name) : String(body.source);
        const controller = new AbortController();
        busyRef.current = busyKey;
        actionControllerRef.current = controller;
        setBusy({ kind: kind, key: busyKey });
        setActionError('');
        setNotice('');
        (async () => {
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/routes/' + kind, {
              method: 'POST',
              mode: 'cors',
              cache: 'no-store',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-oorp-client': CLIENT_HEADER,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            if (!response.ok) {
              throw new Error(payloadErrorMessage(payload) || t('error.http', { status: String(response.status) }));
            }
            if (isPlainObject(payload) && payload.ok === false) {
              throw new Error(payloadErrorMessage(payload) || t('error.http', { status: String(response.status) }));
            }
            if (!mountedRef.current) return;
            busyRef.current = null;
            setBusy(null);
            setNotice(t(successKey, { name: successName }));
            setTargetsKey((key) => key + 1);
            if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = setTimeout(() => {
              noticeTimerRef.current = null;
              if (mountedRef.current) setNotice('');
            }, NOTICE_MS);
          } catch (error) {
            if (!mountedRef.current) return;
            if (error && error.name === 'AbortError') return;
            busyRef.current = null;
            setBusy(null);
            setActionError(t('providers.actionFailed', { message: errorMessage(t, error) }));
          } finally {
            if (actionControllerRef.current === controller) {
              actionControllerRef.current = null;
              busyRef.current = null;
            }
          }
        })();
      };

      /*
       * Ask the relay to fill effort levels onto every route this page owns.
       * It is a config write, so it shares the create/remove guards: one action
       * at a time, aborted on unmount, and the same error line. A refresh (not
       * the response) drives the rows, and `changed: false` is calm — nothing
       * was written because every owned route already had a capability.
       */
      const runRepair = () => {
        if (busy !== null || busyRef.current !== null) return;
        const controller = new AbortController();
        busyRef.current = 'repair';
        actionControllerRef.current = controller;
        setBusy({ kind: 'repair', key: 'repair' });
        setActionError('');
        setNotice('');
        (async () => {
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/routes/repair', {
              method: 'POST',
              mode: 'cors',
              cache: 'no-store',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-oorp-client': CLIENT_HEADER,
              },
              body: '{}',
              signal: controller.signal,
            });
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            if (!response.ok) {
              throw new Error(payloadErrorMessage(payload) || t('error.http', { status: String(response.status) }));
            }
            if (isPlainObject(payload) && payload.ok === false) {
              throw new Error(payloadErrorMessage(payload) || t('error.http', { status: String(response.status) }));
            }
            const result = normalizeRepairPayload(payload);
            if (result === null) throw new Error(t('error.badRepair'));
            if (!mountedRef.current) return;
            busyRef.current = null;
            setBusy(null);
            let message;
            if (result.changed) {
              message = t('providers.noticeRepaired', { count: formatCount(result.models) });
              if (result.unresolved > 0) {
                message += ' ' + t('providers.noticeRepairedUnresolved', { count: formatCount(result.unresolved) });
              }
            } else if (result.unresolved > 0) {
              message = t('providers.noticeRepairUnresolved', { count: formatCount(result.unresolved) });
            } else {
              message = t('providers.noticeRepairNoop');
            }
            setNotice(message);
            setTargetsKey((key) => key + 1);
            if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
            noticeTimerRef.current = setTimeout(() => {
              noticeTimerRef.current = null;
              if (mountedRef.current) setNotice('');
            }, NOTICE_MS);
          } catch (error) {
            if (!mountedRef.current) return;
            if (error && error.name === 'AbortError') return;
            busyRef.current = null;
            setBusy(null);
            setActionError(t('providers.actionFailed', { message: errorMessage(t, error) }));
          } finally {
            if (actionControllerRef.current === controller) {
              actionControllerRef.current = null;
              busyRef.current = null;
            }
          }
        })();
      };

      const copyBaseURL = (path, url) => {
        writeClipboard(url)
          .then((ok) => {
            if (!mountedRef.current) return;
            if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
            setCopyState({ path: path, ok: ok });
            copyTimerRef.current = setTimeout(() => {
              copyTimerRef.current = null;
              if (mountedRef.current) setCopyState(null);
            }, COPY_FEEDBACK_MS);
          })
          .catch(() => {});
      };

      const retryConnection = () => {
        setConnection('checking');
        setStatusError('');
        setRefreshKey((key) => key + 1);
      };

      const reloadTargets = () => setTargetsKey((key) => key + 1);

      /* ---------------------------------------------------------------- derived values */

      const relayOrigin = snapshot !== null && snapshot.origin !== '' ? snapshot.origin : origin;
      const upstreamHost = snapshot !== null ? hostOf(snapshot.upstream) : '';
      const mounts = snapshot !== null ? snapshot.mounts : [];
      const metrics = snapshot !== null ? snapshot.metrics : null;
      const totalTokens = metrics !== null ? metrics.promptTokens + metrics.completionTokens : 0;
      const availableTiers = snapshot !== null ? tiersFromMounts(mounts) : TIER_FALLBACK.slice();
      const byTier = metrics !== null ? metrics.byTier : {};
      const tierOptions = availableTiers.map((tier) => ({
        value: tier,
        label: t('providers.tierOption', {
          tier: tier,
          multiplier: multiplierLabel(t, tierMultiplierFor(tier, byTier)),
        }),
      }));

      const targetsData = targets.data;
      const createdNames = Object.create(null);
      if (targetsData !== null) {
        for (const route of targetsData.created) createdNames[route.name] = true;
      }
      let missingReasoningTotal = 0;
      if (targetsData !== null) {
        for (const route of targetsData.created) missingReasoningTotal += route.missingReasoning;
      }
      const reasoningFill = targetsData !== null && targetsData.reasoning !== null ? targetsData.reasoning.fill : null;

      const connectionKey =
        connection === 'online' ? 'status.online' : connection === 'offline' ? 'status.offline' : 'status.checking';

      let savingsSentence = t('savings.idle');
      if (metrics !== null) {
        if (metrics.requests === 0) {
          savingsSentence = t('savings.idle');
        } else if (totalTokens === 0 || metrics.effectiveMultiplier === null) {
          savingsSentence = t('savings.noTokens');
        } else {
          const rounded = roundTwo(metrics.effectiveMultiplier);
          const label = t('common.multiplier', { value: String(rounded) });
          if (rounded < 0.995) savingsSentence = t('savings.below', { multiplier: label });
          else if (rounded > 1.005) savingsSentence = t('savings.above', { multiplier: label });
          else savingsSentence = t('savings.equal', { multiplier: label });
        }
      }

      /* ---------------------------------------------------------------- render helpers */

      const header = h(
        'header',
        { style: HEADER_STYLE },
        h(
          'div',
          { style: HEADER_ROW_STYLE },
          h('span', { style: dotStyle(connection), 'aria-hidden': 'true' }),
          h('h2', { style: TITLE_STYLE }, t('card.title')),
          h('span', { role: 'status', 'aria-live': 'polite', style: STATUS_TEXT_STYLE }, t(connectionKey)),
          snapshot !== null && snapshot.version !== ''
            ? h(
                'span',
                { style: Object.assign({}, STATUS_TEXT_STYLE, { color: COLORS.tertiary }) },
                t('common.version', { version: snapshot.version }),
              )
            : null,
        ),
        h(
          'div',
          { style: META_ROW_STYLE },
          h(
            'span',
            { style: META_ITEM_STYLE },
            h('span', { style: META_LABEL_STYLE }, t('header.relay')),
            h('code', { style: codeStyle }, relayOrigin),
          ),
          h(
            'span',
            { style: META_ITEM_STYLE },
            h('span', { style: META_LABEL_STYLE }, t('header.upstream')),
            h('code', { style: codeStyle }, upstreamHost !== '' ? upstreamHost : t('common.unknown')),
          ),
        ),
      );

      const renderOffline = () =>
        h(
          'section',
          { style: sectionStyle() },
          h('h4', { style: H4_STYLE }, t('offline.title')),
          statusError !== ''
            ? h('p', { style: HINT_STYLE }, t('offline.reason', { message: statusError }))
            : null,
          h('p', { style: HINT_STYLE }, t('offline.expected', { origin: EXPECTED_ORIGIN, ports: FALLBACK_PORTS })),
          h('p', { style: HINT_STYLE }, t('offline.hint')),
          h('div', null, h(ActionButton, { label: t('offline.retry'), onClick: retryConnection })),
        );

      const renderMounts = () => {
        const rows =
          mounts.length === 0
            ? [
                h(
                  'tr',
                  { key: 'empty' },
                  h(
                    'td',
                    { colSpan: 6, style: Object.assign({}, TD_STYLE, { color: COLORS.secondary }) },
                    t('mounts.empty'),
                  ),
                ),
              ]
            : mounts.map((mount) => {
                const baseURL = joinURL(relayOrigin, mount.path);
                const copying = copyState !== null && copyState.path === mount.path;
                const copied = copying && copyState.ok === true;
                return h(
                  'tr',
                  { key: mount.path },
                  h(
                    'td',
                    { style: TD_STYLE },
                    h('div', { style: codeStyle }, mount.path),
                    h('div', { style: mutedCodeStyle }, baseURL),
                  ),
                  h(
                    'td',
                    { style: TD_STYLE },
                    h('span', { style: BADGE_STYLE }, mount.tier === null ? t('mounts.passthrough') : mount.tier),
                  ),
                  h('td', { style: TD_RIGHT_STYLE }, multiplierLabel(t, mount.multiplier)),
                  h('td', { style: TD_RIGHT_STYLE }, formatCount(mount.requests)),
                  h(
                    'td',
                    { style: TD_RIGHT_STYLE },
                    formatCount(mount.promptTokens + mount.completionTokens),
                  ),
                  h(
                    'td',
                    { style: TD_RIGHT_STYLE },
                    h(ActionButton, {
                      label: copying
                        ? copied
                          ? t('mounts.copied')
                          : t('mounts.copyFailed')
                        : t('mounts.copy'),
                      ariaLabel: t('mounts.copyAria', { path: mount.path }),
                      title: baseURL,
                      onClick: () => copyBaseURL(mount.path, baseURL),
                    }),
                  ),
                );
              });

        return h(
          'section',
          { style: sectionStyle() },
          h(
            'table',
            { style: TABLE_STYLE },
            h(
              'caption',
              { style: CAPTION_STYLE },
              t('mounts.caption'),
              h('span', { style: CAPTION_HINT_STYLE }, t('mounts.hint')),
            ),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col', style: TH_STYLE }, t('mounts.column.mount')),
                h('th', { scope: 'col', style: TH_STYLE }, t('mounts.column.tier')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('mounts.column.multiplier')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('mounts.column.requests')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('mounts.column.tokens')),
                h(
                  'th',
                  { scope: 'col', style: TH_RIGHT_STYLE },
                  h('span', { style: visuallyHidden }, t('mounts.column.copy')),
                ),
              ),
            ),
            h('tbody', null, rows),
          ),
          h(
            'span',
            { role: 'status', style: visuallyHidden },
            copyState === null ? '' : copyState.ok === true ? t('mounts.copied') : t('mounts.copyFailed'),
          ),
        );
      };

      const renderSavings = () =>
        h(
          'section',
          { style: sectionStyle() },
          h('h4', { style: H4_STYLE }, t('savings.caption')),
          h(
            'div',
            { style: STATS_ROW_STYLE },
            h(
              'div',
              { style: STAT_STYLE },
              h('span', { style: STAT_LABEL_STYLE }, t('savings.requests')),
              h('span', { style: { font: FONTS.strong } }, formatCount(metrics !== null ? metrics.requests : 0)),
            ),
            h(
              'div',
              { style: STAT_STYLE },
              h('span', { style: STAT_LABEL_STYLE }, t('savings.tokens')),
              h('span', { style: { font: FONTS.strong } }, formatCount(totalTokens)),
            ),
            h(
              'div',
              { style: STAT_STYLE },
              h('span', { style: STAT_LABEL_STYLE }, t('savings.multiplier')),
              h('span', { style: { font: FONTS.metric } }, multiplierLabel(t, metrics !== null ? metrics.effectiveMultiplier : null)),
            ),
          ),
          h('p', { style: PARAGRAPH_STYLE }, savingsSentence),
          h('p', { style: HINT_STYLE }, t('savings.note')),
        );

      const renderRecent = () => {
        const rows =
          metrics === null || metrics.recent.length === 0
            ? [
                h(
                  'tr',
                  { key: 'empty' },
                  h(
                    'td',
                    { colSpan: 5, style: Object.assign({}, TD_STYLE, { color: COLORS.secondary }) },
                    t('recent.empty'),
                  ),
                ),
              ]
            : metrics.recent.map((entry, index) => {
                const time = localTime(entry.at);
                const tokensTitle =
                  entry.tokens === null && entry.bytes !== null
                    ? t('recent.bytesTitle', { bytes: formatCount(entry.bytes) })
                    : undefined;
                return h(
                  'tr',
                  { key: String(index) },
                  h(
                    'td',
                    { style: TD_STYLE },
                    h('span', { style: BADGE_STYLE }, entry.tier === null ? t('common.defaultTier') : entry.tier),
                  ),
                  h(
                    'td',
                    { style: TD_STYLE },
                    h('div', { style: codeStyle }, entry.model !== '' ? entry.model : t('common.notAvailable')),
                    time !== '' ? h('div', { style: { color: COLORS.secondary, font: FONTS.tiny } }, time) : null,
                    entry.streaming
                      ? h(
                          'span',
                          { style: { color: COLORS.secondary, font: FONTS.tiny }, title: t('recent.streamTitle') },
                          t('recent.stream'),
                        )
                      : null,
                  ),
                  h(
                    'td',
                    { style: TD_STYLE },
                    entry.status === null ? t('common.notAvailable') : String(entry.status),
                  ),
                  h(
                    'td',
                    { style: TD_RIGHT_STYLE },
                    entry.ms === null ? t('common.notAvailable') : t('common.ms', { value: formatCount(entry.ms) }),
                  ),
                  h(
                    'td',
                    { style: TD_RIGHT_STYLE, title: tokensTitle },
                    entry.tokens === null ? t('common.notAvailable') : formatCount(entry.tokens),
                  ),
                );
              });

        return h(
          'section',
          { style: sectionStyle() },
          h(
            'table',
            { style: TABLE_STYLE },
            h(
              'caption',
              { style: CAPTION_STYLE },
              t('recent.caption'),
              h('span', { style: CAPTION_HINT_STYLE }, t('recent.hint')),
            ),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.tier')),
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.model')),
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.status')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('recent.column.ms')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('recent.column.tokens')),
              ),
            ),
            h('tbody', null, rows),
          ),
        );
      };

      const renderSources = () => {
        const rows = [];
        if (targetsData.sources.length === 0) {
          rows.push(h('p', { key: 'empty', style: HINT_STYLE }, t('providers.emptySources')));
        } else {
          for (const source of targetsData.sources) {
            const chosen = hasOwn(tierChoices, source.key) ? tierChoices[source.key] : '';
            const tier = availableTiers.indexOf(chosen) >= 0 ? chosen : defaultTierFor(source, availableTiers);
            const routeName = proposedRouteName(source.key, tier);
            const exists = createdNames[routeName] === true;
            const creating = busy !== null && busy.kind === 'create' && busy.key === source.key;
            rows.push(
              h(
                'div',
                { key: source.key, style: ROW_STYLE },
                h(
                  'div',
                  { style: ROW_INFO_STYLE },
                  h('span', { style: { font: FONTS.strong } }, source.displayName),
                  h(
                    'span',
                    { style: HINT_STYLE },
                    t('providers.sourceModels', {
                      api: source.api !== '' ? source.api : t('common.unknown'),
                      count: formatCount(source.modelCount),
                    }),
                  ),
                  source.apiKeyEnv !== ''
                    ? h('span', { style: HINT_STYLE }, t('providers.sourceKey', { env: source.apiKeyEnv }))
                    : null,
                  h('span', { style: HINT_STYLE }, t('providers.routeName', { name: routeName })),
                  exists ? h('span', { style: HINT_STYLE }, t('providers.exists', { name: routeName })) : null,
                ),
                h(
                  'div',
                  { style: ROW_CONTROL_STYLE },
                  h(TierSelect, {
                    value: tier,
                    options: tierOptions,
                    disabled: busy !== null,
                    ariaLabel: t('providers.tierAria', { name: source.displayName }),
                    onChange: (nextTier) =>
                      setTierChoices((previous) => {
                        const updated = Object.assign({}, previous);
                        updated[source.key] = nextTier;
                        return updated;
                      }),
                  }),
                  h(ActionButton, {
                    label: creating ? t('providers.creating') : t('providers.create'),
                    ariaLabel: t('providers.createAria', { name: routeName }),
                    disabled: busy !== null || exists,
                    onClick: () =>
                      runRouteAction(
                        'create',
                        { source: source.key, tier: tier, name: routeName },
                        'providers.noticeCreated',
                        routeName,
                      ),
                  }),
                ),
              ),
            );
          }
        }
        return h(
          'div',
          { key: 'sources', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('div', { style: SUB_LABEL_STYLE }, t('providers.sourcesCaption')),
          rows,
        );
      };

      const renderCreated = () => {
        const rows = [];
        const repairing = busy !== null && busy.kind === 'repair';
        if (targetsData.created.length === 0) {
          rows.push(h('p', { key: 'empty', style: HINT_STYLE }, t('providers.createdEmpty')));
        } else {
          for (const route of targetsData.created) {
            const removing = busy !== null && busy.kind === 'remove' && busy.key === route.name;
            rows.push(
              h(
                'div',
                { key: route.name, style: ROW_STYLE },
                h(
                  'div',
                  { style: ROW_INFO_STYLE },
                  h('code', { style: codeStyle }, route.name),
                  h(
                    'span',
                    { style: HINT_STYLE },
                    t('providers.routeMeta', {
                      source: route.source !== '' ? route.source : t('common.unknown'),
                      tier: route.tier === null ? t('common.defaultTier') : route.tier,
                      count: formatCount(route.modelCount),
                    }),
                  ),
                  route.baseURL !== ''
                    ? h('span', { style: mutedCodeStyle }, t('providers.routeBase', { url: route.baseURL }))
                    : null,
                  route.missingReasoning > 0
                    ? h(
                        'span',
                        { style: WARN_HINT_STYLE },
                        t('providers.missingReasoning', { count: formatCount(route.missingReasoning) }),
                      )
                    : null,
                ),
                h(
                  'div',
                  { style: ROW_CONTROL_STYLE },
                  h(ActionButton, {
                    label: removing ? t('providers.removing') : t('providers.remove'),
                    ariaLabel: t('providers.removeAria', { name: route.name }),
                    disabled: busy !== null,
                    onClick: () =>
                      runRouteAction('remove', { name: route.name }, 'providers.noticeRemoved', route.name),
                  }),
                ),
              ),
            );
          }
        }
        /* One line of context next to the repair action, only when it helps:
           how a fill would source the capability. No settings form lives here. */
        let reasoningHint = '';
        if (reasoningFill === 'never') reasoningHint = t('providers.reasoningNever');
        else if (reasoningFill === 'default') reasoningHint = t('providers.reasoningDefault');
        else if (reasoningFill === 'evidence') reasoningHint = t('providers.reasoningEvidence');
        const repair =
          missingReasoningTotal > 0
            ? h(
                'div',
                { key: 'repair', style: REPAIR_ROW_STYLE },
                h(ActionButton, {
                  label: repairing
                    ? t('providers.repairing')
                    : t('providers.repair', { count: formatCount(missingReasoningTotal) }),
                  ariaLabel: t('providers.repairAria', { count: formatCount(missingReasoningTotal) }),
                  disabled: busy !== null,
                  onClick: runRepair,
                }),
                reasoningHint !== '' ? h('p', { key: 'hint', style: HINT_STYLE }, reasoningHint) : null,
              )
            : null;
        return h(
          'div',
          { key: 'created', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('div', { style: SUB_LABEL_STYLE }, t('providers.createdCaption')),
          rows,
          repair,
        );
      };

      const renderTargetsBody = () => {
        if (targets.status === 'error') {
          return [
            h(
              'p',
              { key: 'error', role: 'alert', style: ALERT_STYLE },
              targets.error !== '' ? targets.error : t('error.badTargets'),
            ),
            h('div', { key: 'retry' }, h(ActionButton, { label: t('providers.retry'), onClick: reloadTargets })),
          ];
        }
        if (targetsData === null) {
          return [h('p', { key: 'loading', style: HINT_STYLE }, t('providers.loading'))];
        }
        if (targetsData.available !== true) {
          return [
            h(
              'p',
              { key: 'unavailable', style: HINT_STYLE },
              targetsData.reason !== ''
                ? t('providers.unavailable', { reason: targetsData.reason })
                : t('providers.unavailableNoReason'),
            ),
          ];
        }
        return [renderSources(), renderCreated()];
      };

      const renderProviders = () =>
        h(
          'section',
          { style: sectionStyle() },
          h('h4', { style: H4_STYLE }, t('providers.caption')),
          h('p', { style: HINT_STYLE }, t('providers.explain')),
          actionError !== '' ? h('p', { role: 'alert', style: ALERT_STYLE }, actionError) : null,
          notice !== ''
            ? h('p', { role: 'status', 'aria-live': 'polite', style: NOTICE_STYLE }, notice)
            : null,
          renderTargetsBody(),
        );

      /* ---------------------------------------------------------------- assembly */

      return h(
        'section',
        { 'aria-label': t('card.regionAria'), style: PAGE_STYLE },
        header,
        h('p', { style: INTRO_STYLE }, t('page.intro')),
        connection === 'offline' ? renderOffline() : null,
        connection === 'online' && snapshot !== null ? renderMounts() : null,
        connection === 'online' && snapshot !== null ? renderSavings() : null,
        connection === 'online' && snapshot !== null ? renderProviders() : null,
        connection === 'online' && snapshot !== null ? renderRecent() : null,
      );
    }

    /* ------------------------------------------------------ provider-row extension */

    /**
     * Shared `/targets` reader for the provider-row strips. Every row mounts with the
     * settings page, so they all read one snapshot; writes re-read the truth instead of
     * trusting the response, because an attach can restart the relay mid-request.
     */
    function createTargetsFeed() {
      let state = { status: 'idle', origin: null, data: null };
      const listeners = new Set();
      const controllers = new Set();
      let inflight = null;

      const broadcast = (next) => {
        state = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            /* one strip must never break its siblings */
          }
        }
      };

      const abortAll = () => {
        for (const controller of controllers) {
          try {
            controller.abort();
          } catch (error) {
            /* already settled */
          }
        }
        controllers.clear();
      };

      const request = async (url, timeoutMs) => {
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (error) {
            /* already settled */
          }
        }, timeoutMs);
        try {
          return await fetch(url, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
      };

      /** First documented origin that answers `/health`; `quick` keeps a retry cheap. */
      const probe = async (preferred, quick) => {
        const candidates = [];
        if (typeof preferred === 'string' && preferred !== '') candidates.push(preferred);
        const rest = quick === true ? DEFAULT_ORIGINS.slice(0, 1) : DEFAULT_ORIGINS;
        for (const origin of rest) {
          if (candidates.indexOf(origin) < 0) candidates.push(origin);
        }
        for (const origin of candidates) {
          try {
            const response = await request(origin + CONTROL_PREFIX + '/health', PROBE_TIMEOUT_MS);
            if (!response.ok) continue;
            const payload = await readJsonSafe(response);
            if (isPlainObject(payload) && payload.ok !== false) return origin;
          } catch (error) {
            /* try the next documented port */
          }
        }
        return null;
      };

      /** `/targets` when the relay is usable for this extension, else null. */
      const readTargets = async (origin) => {
        try {
          const response = await request(origin + CONTROL_PREFIX + '/targets', STATUS_TIMEOUT_MS);
          if (!response.ok) return null;
          const data = normalizeTargets(await readJsonSafe(response));
          if (data === null || data.available !== true) return null;
          return data;
        } catch (error) {
          return null;
        }
      };

      const load = () => {
        if (inflight !== null) return inflight;
        inflight = (async () => {
          broadcast({ status: state.data === null ? 'loading' : 'ready', origin: state.origin, data: state.data });
          try {
            const origin = await probe(state.origin, false);
            if (origin === null) {
              broadcast({ status: 'unavailable', origin: null, data: null });
              return null;
            }
            const data = await readTargets(origin);
            if (data === null) {
              broadcast({ status: 'unavailable', origin: null, data: null });
              return null;
            }
            broadcast({ status: 'ready', origin: origin, data: data });
            return { origin: origin, data: data };
          } catch (error) {
            broadcast({ status: 'unavailable', origin: null, data: null });
            return null;
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) void load();
          return () => {
            listeners.delete(listener);
            if (listeners.size > 0) return;
            abortAll();
            inflight = null;
          };
        },
        snapshot() {
          return state;
        },
        publish(origin, data) {
          broadcast({ status: 'ready', origin: origin, data: data });
        },
        probe,
        readTargets,
      };
    }

    /** Hard stop for the strip: a thrown render must leave the provider card intact. */
    class StripBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error, info) {
        try {
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[dsh-openrouter-plus] provider-row strip render failed', error, info);
          }
        } catch (ignored) {
          /* logging must never throw out of an error boundary */
        }
      }

      render() {
        return this.state.failed === true ? null : this.props.children;
      }
    }

    /**
     * One provider row's relay switch. Rendered by the Models page for every saved row;
     * it answers only for the `llm-pi-ai` family and renders null for everything else,
     * when the relay is unreachable, and when the row has no usable upstream.
     */
    function ProviderRouteStrip(props) {
      const t = props.t;
      const feed = props.feed;
      const provider = isPlainObject(props.provider) ? props.provider : null;
      const route = provider === null ? '' : stringValue(provider.provider).trim();
      const isPiAi = provider !== null && stringValue(provider.settingsNs).trim() === PI_AI_NS;

      const [feedState, setFeedState] = React.useState(() => feed.snapshot());
      const [chooserOpen, setChooserOpen] = React.useState(false);
      const [tier, setTier] = React.useState('');
      const [pending, setPending] = React.useState(null);
      const [error, setError] = React.useState('');

      const aliveRef = React.useRef(true);
      const lifetimeRef = React.useRef(null);
      const actionControllerRef = React.useRef(null);

      React.useEffect(() => {
        aliveRef.current = true;
        const lifetime = new AbortController();
        lifetimeRef.current = lifetime;
        return () => {
          aliveRef.current = false;
          try {
            lifetime.abort();
          } catch (error) {
            /* already aborted */
          }
          lifetimeRef.current = null;
          if (actionControllerRef.current !== null) {
            try {
              actionControllerRef.current.abort();
            } catch (error) {
              /* already settled */
            }
            actionControllerRef.current = null;
          }
        };
      }, []);

      /* Rows of other adapters never read the relay: they must stay untouched guests. */
      React.useEffect(() => {
        if (!isPiAi) return undefined;
        return feed.subscribe(() => setFeedState(feed.snapshot()));
      }, [feed, isPiAi]);

      /* The owner hands us a fresh directory object on every snapshot: derive the draft
         from the row's id, never from object identity, and drop local state when the row
         changes underneath us. */
      React.useEffect(() => {
        setChooserOpen(false);
        setTier('');
        setPending(null);
        setError('');
      }, [route]);

      const data = feedState.data;
      if (!isPiAi || provider === null || route === '' || data === null) return null;

      const source = providerSourceOf(data, route);
      const own = relayTargetOf(data, route);
      const routed = own === null ? relayRouteOf(data, route) : null;
      /* Upstream to remember: the live row wins, then the adapter's default. A catalog row
         reports an empty baseURL (it resolves one from the installed catalog or an env
         var), and the default is the only endpoint the strip can honestly offer; a row
         with neither has nothing to repoint and renders no switch. */
      const storedUpstream = source === null ? '' : absoluteHttpURL(source.baseURL);
      const upstream =
        storedUpstream !== '' ? storedUpstream : absoluteHttpURL(stringValue(provider.defaultBaseURL));
      const name = stringValue(provider.displayName).trim() || route;
      const groupAria = t('strip.groupAria', { name: name });

      /*
       * Re-read the truth after a write. The first attempt after a cut usually lands on a
       * listener that is still rebinding, so retry with small gaps; each attempt is
       * cheap: `/health` then `/targets` on the origin that answered.
       */
      const reconcile = async () => {
        const gaps = RECONCILE_DELAYS_MS;
        for (let attempt = 0; attempt < gaps.length; attempt += 1) {
          await sleepUntil(gaps[attempt], lifetimeRef.current === null ? null : lifetimeRef.current.signal);
          if (!aliveRef.current) return null;
          const origin = await feed.probe(feedState.origin, attempt < gaps.length - 1);
          if (!aliveRef.current) return null;
          if (origin === null) continue;
          const next = await feed.readTargets(origin);
          if (!aliveRef.current) return null;
          if (next !== null) return { origin: origin, data: next };
        }
        return null;
      };

      /** An aborted write is the relay reloading, not a verdict; say so plainly. */
      const mutationMessage = (error) => (error && error.name === 'AbortError' ? t('strip.stalled') : errorMessage(t, error));

      const post = async (kind, body, explicitOrigin) => {
        const origin = explicitOrigin === undefined ? feedState.origin : explicitOrigin;
        if (origin === null || origin === undefined) throw new Error(t('offline.noReason'));
        const controller = new AbortController();
        actionControllerRef.current = controller;
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (error) {
            /* already settled */
          }
        }, MUTATION_TIMEOUT_MS);
        try {
          const response = await fetch(origin + CONTROL_PREFIX + '/routes/' + kind, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-store',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-oorp-client': CLIENT_HEADER,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const payload = await readJsonSafe(response);
          if (!response.ok) {
            const message = payloadErrorMessage(payload);
            throw new Error(message === '' ? t('error.http', { status: String(response.status) }) : message);
          }
          return payload;
        } finally {
          clearTimeout(timer);
          if (actionControllerRef.current === controller) actionControllerRef.current = null;
        }
      };

      /* Render the state the relay reports, never the intent: a rejected or cut call can
         still have changed the config, so the re-read decides between success and error. */
      const attach = async () => {
        if (pending !== null || upstream === '') return;
        const body = { route: route, upstream: upstream, tier: tier };
        setPending('attach');
        setError('');
        let failure = '';
        try {
          await post('attach', body);
        } catch (exception) {
          failure = mutationMessage(exception);
        }
        let found = await reconcile();
        let backed = found !== null && relayTargetOf(found.data, route) !== null;
        if (found !== null) feed.publish(found.origin, found.data);
        if (!backed) {
          /* The target write already landed, so this second attempt reuses it without
             touching our config again (no reload) and normally completes cleanly. The
             relay may have rebounded to another documented port, so aim at the origin
             the re-read just found. */
          try {
            await post('attach', body, found === null ? undefined : found.origin);
          } catch (exception) {
            failure = mutationMessage(exception);
          }
          found = await reconcile();
          if (found !== null) feed.publish(found.origin, found.data);
          backed = found !== null && relayTargetOf(found.data, route) !== null;
        }
        if (!aliveRef.current) return;
        if (backed) {
          /* The row is routed now, so the local chooser starts over next time it opens:
             a detach/attach cycle must not silently reuse the last tier. */
          setChooserOpen(false);
          setTier('');
          setError('');
        } else {
          setChooserOpen(false);
          setError(t('providers.actionFailed', { message: failure !== '' ? failure : t('strip.stalled') }));
        }
        setPending(null);
      };

      /* Detach restores the row instead of deleting the target: the endpoint stays
         registered for a later re-attach, so success means this route no longer links
         to one. A re-read that cannot reach the relay is "unknown" — one idempotent
         retry, then the error line. */
      const detach = async () => {
        if (pending !== null || own === null) return;
        const body = { route: route, id: own.id };
        setPending('detach');
        setError('');
        let failure = '';
        try {
          await post('detach', body);
        } catch (exception) {
          failure = mutationMessage(exception);
        }
        let found = await reconcile();
        let attached = found === null || relayTargetOf(found.data, route) !== null;
        if (found !== null) feed.publish(found.origin, found.data);
        if (attached) {
          try {
            await post('detach', body, found === null ? undefined : found.origin);
          } catch (exception) {
            failure = mutationMessage(exception);
          }
          found = await reconcile();
          if (found !== null) feed.publish(found.origin, found.data);
          attached = found === null || relayTargetOf(found.data, route) !== null;
        }
        if (!aliveRef.current) return;
        if (attached) {
          setError(t('providers.actionFailed', { message: failure !== '' ? failure : t('strip.stalled') }));
        } else {
          setChooserOpen(false);
          setTier('');
          setError('');
        }
        setPending(null);
      };

      const errorLine = error === '' ? null : h('p', { role: 'alert', style: ALERT_STYLE }, error);

      if (own !== null) {
        return h(
          'div',
          {
            role: 'group',
            'aria-label': groupAria,
            'aria-busy': pending === null ? undefined : 'true',
            style: STRIP_STYLE,
          },
          h(
            'span',
            { role: 'status', 'aria-live': 'polite', style: STRIP_STATUS_STYLE },
            h('span', null, t('strip.routed')),
            h('span', { style: BADGE_STYLE }, own.tier === null ? t('mounts.passthrough') : own.tier),
          ),
          errorLine,
          h(ActionButton, {
            label: pending === 'detach' ? t('strip.detaching') : t('strip.detach'),
            ariaLabel: t('strip.detachAria', { name: name }),
            disabled: pending !== null,
            onClick: () => {
              void detach();
            },
          }),
        );
      }

      if (routed !== null) {
        return h(
          'div',
          { role: 'group', 'aria-label': groupAria, style: STRIP_STYLE },
          h(
            'span',
            { role: 'status', 'aria-live': 'polite', style: STRIP_STATUS_STYLE },
            h('span', null, t('strip.routed')),
            h('span', { style: BADGE_STYLE }, routed.tier === null ? t('mounts.passthrough') : routed.tier),
          ),
          errorLine,
        );
      }

      /* No stored row and no default: there is nothing this extension can repoint, and an
         attach would need a route the config does not have yet. */
      if (source === null || upstream === '') return null;

      const options = ATTACH_TIERS.map((value) => ({
        value: value,
        label:
          value === ''
            ? t('strip.tierNone')
            : t('providers.tierOption', {
                tier: value,
                multiplier: multiplierLabel(t, tierMultiplierFor(value, null)),
              }),
      }));

      const ticked = chooserOpen || pending === 'attach';

      return h(
        'div',
        {
          role: 'group',
          'aria-label': groupAria,
          'aria-busy': pending === null ? undefined : 'true',
          style: STRIP_STYLE,
        },
        h(
          'label',
          { style: STRIP_LABEL_STYLE },
          h('input', {
            type: 'checkbox',
            checked: ticked,
            disabled: pending !== null,
            style: { margin: 0 },
            onChange: (event) => {
              const next = event.target.checked === true;
              setChooserOpen(next);
              if (!next) setTier('');
              if (error !== '') setError('');
            },
          }),
          h('span', null, t('strip.route')),
        ),
        errorLine,
        chooserOpen || pending === 'attach'
          ? h(
              'div',
              { style: STRIP_CHOOSER_STYLE },
              h(TierSelect, {
                value: tier,
                ariaLabel: t('strip.tierAria', { name: name }),
                disabled: pending !== null,
                options: options,
                onChange: (value) => setTier(value),
              }),
              h(ActionButton, {
                label: pending === 'attach' ? t('strip.applying') : t('strip.apply'),
                disabled: pending !== null,
                onClick: () => {
                  void attach();
                },
              }),
              h('p', { style: STRIP_HINT_STYLE }, t('strip.tierHint')),
            )
          : null,
      );
    }

    /* -------------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /* Dictionary registration is owned by the plugin context and disposed with it. */
        ctx.effect(
          () => ctx.locale.register(NS, { en: en, zh: zh }),
          'dsh-openrouter-plus: locale dictionaries',
        );

        const t = ctx.locale.bind(NS);

        function OpenRouterPlusPage() {
          return h(PageBoundary, { t: t }, h(PageBody, { t: t }));
        }

        /*
        * Its own Settings page rather than a card inside Models: the relay is operator
        * furniture (status, mounts, routes, traffic), and it polls the loopback listener
        * while open. `order: 12` lands it directly after Models, where a reader looking
        * for provider routing starts. The label is a thunk so a locale switch retitles
        * the nav row without re-registering.
        */
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'openrouter-plus', order: 12, label: () => t('nav') },
            OpenRouterPlusPage,
          ),
        );

        /*
         * The Models page dispatches `settings.models.provider-card` once per provider card,
         * keyed by the row's settings namespace. We answer only for `llm-pi-ai`, so the
         * strip appears on that family's rows and nowhere else; the seat itself is declared
         * by the Models section, which is mounted independently of our own page.
         */
        const targetsFeed = createTargetsFeed();

        function ProviderRouteExtension(ownerProps) {
          return h(
            StripBoundary,
            null,
            h(ProviderRouteStrip, Object.assign({}, ownerProps, { t: t, feed: targetsFeed })),
          );
        }

        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register(
            { name: 'settings.models.provider-card', key: PI_AI_NS },
            ProviderRouteExtension,
          ),
        );
      },
    };
  },
});
