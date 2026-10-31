window.__ModuleLoader__.load({
  id: 'dsh-openrouter-plus',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /*
     * Detaching the details dialog needs a React root of its own (see
     * `createUsageDialogMount`). The host publishes react-dom/client to every plugin, but a
     * host that does not is still usable: the dialog then stays inline in the card, exactly
     * as before, instead of the bundle throwing on import.
     */
    const ReactDOM = (() => {
      try {
        return require('react-dom/client');
      } catch (error) {
        return null;
      }
    })();

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-openrouter-plus';

    /** Control API served by the relay listener (loopback only). */
    const CONTROL_PREFIX = '/__openrouter-plus';
    const CLIENT_HEADER = 'web';

    /**
     * The control API, addressed relative to this document's own origin.
     *
     * The Host mounts it on the DSH web server (`ctx.webServer`), so the page and
     * the API always share an origin: no loopback port to reach, no CORS, and no
     * difference between a desktop tab and a phone on the tailnet. An absolute
     * loopback URL could only ever be right on the machine that runs the relay,
     * which is exactly the bug this base removes.
     */
    const CONTROL_BASE = '';
    const POLL_INTERVAL_MS = 3000;
    const STATUS_TIMEOUT_MS = 2500;
    const PROBE_TIMEOUT_MS = 900;
    const COPY_FEEDBACK_MS = 1600;
    const NOTICE_MS = 5000;
    const RECENT_LIMIT = 5;

    /*
     * The sidebar spend card polls `/status` itself instead of sharing the settings page's
     * poll: that poll is local to `PageBody`, and turning its status machine into a store
     * two surfaces subscribe to — error state, retry key, origin switch — would be a
     * rewrite of code that works to save one loopback GET. Five seconds is the card's
     * whole freshness budget: money only moves while a request is relayed.
     */
    const USAGE_POLL_INTERVAL_MS = 5000;
    /** The Host retains 50; the details dialog lists everything it sends. */
    const USAGE_RECENT_LIMIT = 50;
    /**
     * How long the settings page keeps an optimistic widget flag while the plugin reloads.
     * A config write restarts the relay listener, so `/status` can answer the old flag for
     * a moment; after this the next answer wins rather than the click.
     */
    const WIDGET_SETTLE_MS = 10000;

    /** One URL for every control call: the prefix, resolved against this page. */
    function controlUrl(pathText) {
      const suffix = String(pathText ?? '');
      if (suffix === '') return CONTROL_PREFIX;
      return suffix.charAt(0) === '/' ? CONTROL_PREFIX + suffix : CONTROL_PREFIX + '/' + suffix;
    }

    /**
     * The adapter family whose Models rows this plugin extends. The Models page
     * dispatches `settings.models.provider-card` with the row's settings namespace as
     * the key, so this constant is both our registration key and our filter.
     */
    const PI_AI_NS = 'llm-pi-ai';

    /**
     * Service-tier presets, in the order the composer and the settings page offer them.
     * A preset is an outcome ("cheapest", "priority"), never a raw wire field: the relay
     * expands it into `service_tier`, `provider.sort` or a model variant, because those
     * three levers have different contracts and only some combinations are defined.
     */
    const PRESET_IDS = Object.freeze([
      'none',
      'standard',
      'fastest',
      'fastest-standard',
      'cheapest',
      'flex',
      'priority',
      'ultra',
      'floor',
    ]);

    /** The tier vocabulary, so a client paired with a relay that still speaks it maps. */
    const LEGACY_TIER_PRESET = Object.freeze({
      auto: 'none',
      default: 'standard',
      flex: 'flex',
      priority: 'priority',
      fast: 'priority',
      ultrafast: 'ultra',
      scale: 'none',
    });

    /** A tier name as the preset it now means; `null` when nothing is pinned. */
    function presetFromLegacyTier(value) {
      const text = stringValue(value).trim().toLowerCase();
      if (text === '') return null;
      if (PRESET_IDS.includes(text)) return text;
      return LEGACY_TIER_PRESET[text] ?? null;
    }

    /**
     * The precision floors, in menu order. `any` is the behaviour this plugin shipped
     * before the floor existed: it sends no `quantizations` field at all, which is why it
     * is the default and why the chip hides its second half while it is set.
     */
    const PRECISION_FLOORS = Object.freeze(['any', 'no-four-bit', 'eight-bit-up', 'full-width']);

    /** The wire levels each floor admits, in the order the relay materialises `allow`. */
    const PRECISION_WIRE_LEVELS = Object.freeze({
      any: Object.freeze([]),
      'no-four-bit': Object.freeze(['int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32']),
      'eight-bit-up': Object.freeze(['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32']),
      'full-width': Object.freeze(['fp16', 'bf16', 'fp32']),
    });

    /**
     * The popover's panes, after the composer model picker: it opens on `root` — a pair
     * of cells stating what the Session runs on — and a cell drills into the one list it
     * names. `tier` and `precision` are the two drilled panes, in root-cell order.
     */
    const CHIP_PANE_ROOT = 'root';
    const CHIP_PANES = Object.freeze([CHIP_PANE_ROOT, 'tier', 'precision']);

    /**
     * Whether each floor admits endpoints whose precision nobody declared. Mirrors the
     * relay's own table (`lib/quantization.js` `INCLUDE_UNKNOWN_DEFAULT`): on for the two
     * middle floors, off for `full-width` (which would contradict its own name) and for
     * `any` (which sends no list, so the flag has nothing to append to).
     */
    const PRECISION_UNKNOWN_DEFAULT = Object.freeze({
      any: false,
      'no-four-bit': true,
      'eight-bit-up': true,
      'full-width': false,
    });

    /** What the chip badges while the Host has not (yet) told it a floor. */
    const DEFAULT_PRECISION_CHOICE = Object.freeze({ floor: 'any', includeUnknown: false });

    /**
     * Attaching writes our target table first, which makes the Loader re-apply this
     * plugin and restart the listener, so the HTTP response itself can be cut. These
     * are the gaps used while re-reading the truth; an attach whose target already
     * exists is idempotent, which makes the one retry safe.
     */
    const RECONCILE_DELAYS_MS = Object.freeze([350, 450, 550]);
    const MUTATION_TIMEOUT_MS = 6000;

    /* ------------------------------------------------------------------ dictionaries */

    /** English dictionary (key-set source of truth). */
    const en = {
      'nav': 'OpenRouter Plus',
      'card.title': 'OpenRouter Plus',
      'card.regionAria': 'OpenRouter Plus relay',
      'page.intro': 'A loopback relay for OpenRouter. The composer chip picks a routing preset for one Session; a pinned base URL below sets it for a whole route.',

      'common.unknown': 'unknown',
      'common.notAvailable': '—',
      'common.multiplier': '{value}×',
      'common.ms': '{value} ms',
      'common.defaultTier': 'default',
      'common.version': 'v{version}',


      'header.relay': 'Relay',
      'header.upstream': 'Upstream',

      /* The status pill beside the dot. These three keys were missing, so the pill
         rendered its own key name (`status.offline`) instead of a word. */
      'status.online': 'online',
      'status.offline': 'not answering',
      'status.checking': 'checking…',

      'offline.title': 'OpenRouter Plus is not answering',
      'offline.reason': 'Reason: {message}',
      'offline.timeout': 'The control API did not answer within {seconds} s.',
      'offline.noReason': 'no response',
      'offline.retry': 'Retry',
      'offline.hint': 'The Host row is not loaded, or the request was refused. Check the Host log for [openrouter-plus].',

      'error.http': 'HTTP {status}',
      'error.badStatus': 'The relay returned an unexpected status payload.',
      'error.badTargets': 'The relay returned an unexpected provider-routes payload.',
      'error.badRepair': 'The relay returned an unexpected repair result.',
      'error.render': 'The OpenRouter Plus page failed to render; the rest of Settings still works.',

      'mounts.caption': 'Pinned base URLs',
      'mounts.hint': 'The composer chip is the normal control. A route pinned to one of these keeps its preset for every Session on it, and the pin survives a restart.',
      'mounts.column.mount': 'Mount',
      'mounts.column.preset': 'Preset',
      'mounts.column.requests': 'Requests',
      'mounts.column.tokens': 'Tokens',
      'mounts.column.copy': 'Copy base URL',
      'mounts.copy': 'Copy',
      'mounts.copied': 'Copied',
      'mounts.copyFailed': 'Copy failed',
      'mounts.copyAria': 'Copy base URL for {path}',
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
        'Multipliers are relative token prices. The USD figures are what OpenRouter charged for relayed requests, read from each response rather than derived from a price table.',

      'providers.caption': 'Provider routes',
      'providers.explain':
        'Tick \u201cRoute through OpenRouter Plus\u201d on a provider in Settings \u2192 Models, then pick a preset in the composer. The provider keeps its models and key; only its base URL moves onto this relay.',
      'providers.loading': 'Loading provider routes…',
      'providers.retry': 'Reload',
      'providers.unavailable': 'Route editing is unavailable: {reason}',
      'providers.unavailableNoReason': 'Route editing is unavailable in this environment.',
      'providers.createdCaption': 'Routes on this relay',
      'providers.createdEmpty': 'No provider route points at this relay yet.',
      'providers.defaultTierCaption': 'Preset for new sessions',
      'providers.defaultTierHint': 'A session inherits this until it picks its own preset in the composer.',
      'providers.defaultTierAria': 'Preset for new sessions',
      'providers.presetCaption': 'What each preset sends',
      'providers.noticeDefaultTier': 'Saved the preset for new sessions.',
      'providers.routeMeta': '{source} · {tier} · {count} models',
      'providers.routeBase': 'Base URL: {url}',
      'providers.remove': 'Remove',
      'providers.removing': 'Removing…',
      'providers.removeAria': 'Remove route {name}',
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
      'strip.applying': 'Routing\u2026',
      'strip.detaching': 'Restoring\u2026',
      'strip.tierHint': 'Presets only apply to endpoints that accept OpenAI-style routing fields (OpenRouter itself, and some compatible gateways).',
      'strip.routedHint': 'Requests from this provider go through the relay. The preset is chosen per session from the composer chip.',
      'strip.stalled': 'The relay did not confirm the change; reopen this page to retry.',
      'sync.aria': 'Sync {name} with its live model list',
      'sync.action': 'Sync live models\u2026',
      'sync.reading': 'Reading models\u2026',
      'sync.writing': 'Adding\u2026',
      'sync.panelAria': 'Live models of {name}',
      'sync.filter': 'Filter models',
      'sync.legend': '{count} available \u00b7 {present} already added',
      'sync.already': 'added',
      'sync.willRemove': 'will be removed',
      'sync.selected': '{added} to add \u00b7 {removed} to remove',
      'sync.apply': 'Apply',
      'sync.cancel': 'Cancel',
      'sync.done': 'Applied: {added} added, {removed} removed.',
      'sync.noneSelected': 'Nothing changed: tick a model to add, or untick one to remove.',
      'sync.noMatch': 'No model matches that filter.',
      'sync.hint': 'Lists what the endpoint reports right now, so models published after the bundled catalog appear here. Pick only what you want \u2014 nothing else is added and existing entries are left untouched.',
      'sync.loading': 'Reading the endpoint\u2026',
      'sync.truncated': 'Showing the first {shown} of {total} matches \u2014 narrow the filter.',

      'preset.none': 'No pin',
      'preset.standard': 'Standard',
      'preset.fastest': 'Fastest \u00b7 any price',
      'preset.fastest-standard': 'Fastest \u00b7 standard price',
      'preset.cheapest': 'Cheapest',
      'preset.flex': 'Flex',
      'preset.priority': 'Priority',
      'preset.ultra': 'Ultra',
      'preset.floor': 'Floor',
      'preset.inherit': 'Profile default ({preset})',
      'preset.hint': 'Only this session switches. Other sessions keep their own preset.',
      'preset.none.desc': "OpenRouter's own routing: no tier and no comparator are sent, so nothing is pinned.",
      'preset.standard.desc': 'The standard tier only. Priority endpoints are excluded, so no premium can be charged.',
      'preset.fastest.desc': 'Sorts every eligible endpoint by throughput. On an open-weight model this is nitro; on a closed-weight one it stops short of it, because priority endpoints are opt-in there.',
      'preset.fastest-standard.desc': 'The same throughput race with priority endpoints excluded: the fastest answer at the standard rate.',
      'preset.cheapest.desc': 'Sorts by price. It usually lands on a 4-bit quantised endpoint \u2014 the cheapest and the least accurate.',
      'preset.flex.desc': 'Flex endpoints only, at published flex rates. Not necessarily the cheapest, and a capacity error surfaces instead of falling back to standard.',
      'preset.priority.desc': 'Priority endpoints serve first, then standard. OpenAI calls this Fast mode. The premium is charged only when a priority endpoint actually serves.',
      'preset.ultra.desc': 'ultrafast, then priority, then standard. OpenAI models only, and it needs max_tokens to hold \u2014 without one it silently degrades to priority.',
      'preset.floor.desc': 'The :floor variant: a blind price sort over standard and flex endpoints, with no tier preference.',
      'tier.aria': 'Routing preset for {name}: {tier}',
      'tier.switching': 'Switching preset\u2026',
      'tier.error': 'Could not switch the preset: {message}',

      /* The two-level menu: a root pane stating what the Session runs on, and one list
         behind each cell. A floor is a constraint on which endpoints a preset may land on,
         not a preset, so the two are set side by side. */
      'chip.menuAria': 'Routing options',
      'chip.cellAria': '{label}: {value}',
      'chip.facet.tier': 'Tier',
      'chip.facet.precision': 'Precision',
      'precision.row.any': 'Any',
      'precision.row.any.hint': 'No filter: every endpoint stays eligible.',
      'precision.row.no-four-bit': 'No four-bit',
      'precision.row.eight-bit-up': 'Eight-bit up',
      'precision.row.full-width': 'Full width',
      'precision.wireLevels': 'Admits {levels}',
      'precision.unknownAdmitted': 'Unknown precision is admitted',
      'precision.listAria': 'Precision floor for {name}',
      /* Bit-width shorthand for the collapsed badge; `any` has none and is not looked up. */
      'precision.short.no-four-bit': '\u22656-bit',
      'precision.short.eight-bit-up': '\u22658-bit',
      'precision.short.full-width': 'FP16+',
      'precision.error': 'Could not set the precision floor: {message}',

      'recent.caption': 'Recent requests',
      'recent.hint': 'Newest relayed requests first.',
      'recent.column.tier': 'Preset',
      'recent.column.model': 'Model',
      'recent.column.status': 'Status',
      'recent.column.ms': 'Duration',
      'recent.column.tokens': 'Tokens',
      'recent.empty': 'No request has gone through the relay yet.',
      'recent.stream': 'stream',
      'recent.streamTitle': 'Streamed response',
      'recent.bytesTitle': 'No usage reported; {bytes} bytes transferred',

      /* The sidebar spend card and its details dialog. Cost here is money: the billed
         amount each response reported in `usage.cost`. The multiplier above stays a
         weight, so nothing on this surface is derived from a price table. */
      'usage.title': 'OpenRouter',
      'usage.openAria': 'OpenRouter {today}',
      'usage.today': 'Today',
      'usage.total': 'All time',
      'usage.tabsLabel': 'Usage detail sections',
      'usage.tab.models': 'Models',
      'usage.tab.requests': 'Requests',
      'usage.tab.presets': 'Presets',
      'usage.tab.sessions': 'Sessions',
      'usage.dialogTitle': 'OpenRouter usage',
      'usage.close': 'Close',
      'usage.byTier': 'Cost by preset',
      'usage.byTierEmpty': 'No preset has carried a charge in this process yet.',
      'usage.requests': '{count} requests',
      'usage.empty': 'No relayed request reported a model today.',
      'usage.tokensLine': 'Input {input} · Cache {cache} · Output {output}',
      'usage.tokensTitle': 'Input {input} · Cache read {cacheRead} · Cache write {cacheWrite} · Output {output}',
      'usage.column.time': 'Time',
      'usage.column.provider': 'Provider',
      'usage.column.session': 'Session',
      'usage.column.sessionName': 'Name',
      'usage.column.input': 'Input',
      'usage.column.cacheRead': 'Cache read',
      'usage.column.cacheWrite': 'Cache write',
      'usage.column.output': 'Output',
      'usage.column.requests': 'Requests',
      'usage.totalsRow': 'Total',
      'usage.sessionsEmpty': 'No session has been billed in this process yet.',
      'usage.column.cost': 'Cost',
      'usage.column.stream': 'Stream',
      'usage.rowDetailAria': 'Raw fields for the request at {time}',
      'usage.servedAs': 'served {tier}',
      'usage.rawFields': 'Raw OpenRouter fields',
      'usage.servedModel': 'Served model',
      'usage.servedTier': 'Served service tier',
      'usage.byok': 'BYOK',
      'usage.byokNote':
        'With BYOK your own provider key pays the upstream leg: the two amounts below are separate charges, not a sum.',
      'usage.yes': 'yes',
      'usage.no': 'no',
      'usage.costDetails': 'Cost details',
      'usage.costTotal': 'Charged by OpenRouter',
      'usage.costUpstream': 'Billed to your provider key',
      'usage.costPrompt': 'Prompt',
      'usage.costCompletion': 'Completion',
      'usage.costTool': 'Tool',
      'usage.genId': 'Generation id',
      'usage.notReported': 'not reported',
      'usage.usd': '${value}',
      'usage.toggleSettings': 'Show spend card in the sidebar',
      'usage.toggleHint':
        'A collapsible card at the sidebar foot shows today\'s spend and the models that used it. Turning it on reloads the relay.',
      'usage.toggleFailed': 'Could not change the sidebar card: {message}',
    };

    /** Simplified Chinese dictionary, complete against the English key set. */
    const zh = {
      'nav': 'OpenRouter Plus',
      'card.title': 'OpenRouter Plus',
      'card.regionAria': 'OpenRouter Plus 中继',
      'page.intro': '面向 OpenRouter 的本机中继。输入框的预设芯片为单个会话选择路由预设；下方的固定基址则作用于整条路由。',

      'common.unknown': '未知',
      'common.notAvailable': '—',
      'common.multiplier': '{value}×',
      'common.ms': '{value} ms',
      'common.defaultTier': '默认',
      'common.version': 'v{version}',


      'header.relay': '中继',
      'header.upstream': '上游',

      'status.online': '在线',
      'status.offline': '未响应',
      'status.checking': '检查中…',

      'offline.title': 'OpenRouter Plus 未响应',
      'offline.reason': '原因：{message}',
      'offline.timeout': '控制接口在 {seconds} 秒内未响应。',
      'offline.noReason': '无响应',
      'offline.retry': '重试',
      'offline.hint': 'Host 行未加载，或请求被拒绝。请查看 Host 日志中的 [openrouter-plus]。',

      'error.http': 'HTTP {status}',
      'error.badStatus': '中继返回了无法识别的状态数据。',
      'error.badTargets': '中继返回了无法识别的提供商路由数据。',
      'error.badRepair': '中继返回了无法识别的修复结果。',
      'error.render': 'OpenRouter Plus 页面渲染失败；设置的其余部分不受影响。',

      'mounts.caption': '固定基址',
      'mounts.hint': '输入框中的预设芯片是常用方式。把路由固定到下列基址后，该路由上的每个会话都会使用同一预设，且重启后依然有效。',
      'mounts.column.mount': '挂载点',
      'mounts.column.preset': '预设',
      'mounts.column.requests': '请求数',
      'mounts.column.tokens': 'Token 数',
      'mounts.column.copy': '复制基址',
      'mounts.copy': '复制',
      'mounts.copied': '已复制',
      'mounts.copyFailed': '复制失败',
      'mounts.copyAria': '复制 {path} 的基址',
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
      'savings.note': '倍率是相对的 token 价格。美元金额是 OpenRouter 对中继请求的实际计费，取自响应本身，而非按价格表推算。',

      'providers.caption': '提供商路由',
      'providers.explain': '在设置 → 模型里勾选“经 OpenRouter Plus 转发”，再到编辑器中选择预设。提供商会保留自己的模型与密钥，只有基址切换到本中继。',
      'providers.loading': '正在加载提供商路由…',
      'providers.retry': '重新加载',
      'providers.unavailable': '无法编辑路由：{reason}',
      'providers.unavailableNoReason': '当前环境无法编辑路由。',
      'providers.createdCaption': '经由此中继的路由',
      'providers.createdEmpty': '尚无提供商路由指向此中继。',
      'providers.defaultTierCaption': '新会话的预设',
      'providers.defaultTierHint': '会话会继承该设置，直到在输入框中选定自己的预设。',
      'providers.defaultTierAria': '新会话的预设',
      'providers.presetCaption': '各预设实际发送什么',
      'providers.noticeDefaultTier': '已保存新会话的预设。',
      'providers.routeMeta': '{source} · {tier} · {count} 个模型',
      'providers.routeBase': '基址：{url}',
      'providers.remove': '移除',
      'providers.removing': '正在移除…',
      'providers.removeAria': '移除路由 {name}',
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
      'strip.tierAria': '{name} 的预设',
      'strip.applying': '正在转发\u2026',
      'strip.detaching': '正在恢复\u2026',
      'strip.tierHint': '预设只对接受 OpenAI 风格路由字段的端点生效（如 OpenRouter 本身及部分兼容网关）。',
      'strip.routedHint': '该提供商已通过中继转发。预设在输入框的预设按钮里按会话选择。',
      'strip.stalled': '中继未确认本次修改；请重新打开此页面后重试。',
      'sync.aria': '{name} 的实时模型列表同步',
      'sync.action': '同步实时模型\u2026',
      'sync.reading': '正在读取模型\u2026',
      'sync.writing': '正在添加\u2026',
      'sync.panelAria': '{name} 的实时模型',
      'sync.filter': '筛选模型',
      'sync.legend': '可用 {count} \u00b7 已添加 {present}',
      'sync.already': '已添加',
      'sync.willRemove': '将被移除',
      'sync.selected': '新增 {added} \u00b7 移除 {removed}',
      'sync.apply': '应用',
      'sync.cancel': '取消',
      'sync.done': '已应用：新增 {added}，移除 {removed}。',
      'sync.noneSelected': '没有改动：勾选以添加，取消勾选以移除。',
      'sync.noMatch': '没有匹配该筛选条件的模型。',
      'sync.hint': '列出端点当前的模型，因此内置目录发布之后新增的模型也会出现。只添加你勾选的模型，其他内容不会被修改。',
      'sync.loading': '正在读取端点\u2026',
      'sync.truncated': '仅显示前 {shown} 个（共 {total} 个）——请缩小筛选范围。',

      'preset.none': '不固定',
      'preset.standard': '标准',
      'preset.fastest': '最快 \u00b7 不限价格',
      'preset.fastest-standard': '最快 \u00b7 标准价格',
      'preset.cheapest': '最便宜',
      'preset.flex': 'Flex',
      'preset.priority': '优先',
      'preset.ultra': '极速',
      'preset.floor': '底价',
      'preset.inherit': '配置默认（{preset}）',
      'preset.hint': '只切换当前会话；其他会话保持各自的预设。',
      'preset.none.desc': '交给 OpenRouter 自身路由：不发送等级，也不发送排序，什么都不固定。',
      'preset.standard.desc': '只用标准等级，优先端点被排除，因此不会产生溢价。',
      'preset.fastest.desc': '按吞吐量给所有可用端点排序。开源权重模型上这就等于 nitro；闭源权重模型的优先端点需要显式选择，所以不会走到那一步。',
      'preset.fastest-standard.desc': '同样的吞吐量排序，但排除优先端点：标准价格下的最快。',
      'preset.cheapest.desc': '按价格排序，通常会落到 4bit 量化端点——最便宜，也最不精确。',
      'preset.flex.desc': '只用 flex 端点，按 flex 价格计费。不一定最便宜，且容量不足会直接报错，不会回退到标准路由。',
      'preset.priority.desc': '优先端点先服务，其余走标准路由（OpenAI 称之为 Fast 模式）。只有优先级端点真正承接时才收溢价。',
      'preset.ultra.desc': 'ultrafast 优先，其次 priority，再退到标准路由。仅 OpenAI 模型可用，且需要 max_tokens；缺失时会静默降级为 priority。',
      'preset.floor.desc': '`:floor` 变体：在标准与 flex 端点之间盲目按价格排序，不区分等级。',
      'tier.aria': '{name} 的路由预设：{tier}',
      'tier.switching': '正在切换预设\u2026',
      'tier.error': '无法切换预设：{message}',

      /* 两层面板：第一层说明当前路由状态，第二层是各自的选项列表。精度下限不是预设，
         而是对预设所能落到哪些端点的约束，所以两者并列设置。 */
      'chip.menuAria': '路由选项',
      'chip.cellAria': '{label}（当前 {value}）',
      'chip.facet.tier': '预设',
      'chip.facet.precision': '精度',
      'precision.row.any': '不限',
      'precision.row.any.hint': '不做筛选：所有端点都可被选中。',
      'precision.row.no-four-bit': '不含四位',
      'precision.row.eight-bit-up': '八位及以上',
      'precision.row.full-width': '全精度',
      'precision.wireLevels': '可用精度：{levels}',
      'precision.unknownAdmitted': '未声明精度的端点同样可用',
      'precision.listAria': '{name} 的精度下限',
      /* 收起时徽标里的位宽简写，两种语言都保持技术缩写。 */
      'precision.short.no-four-bit': '\u22656位',
      'precision.short.eight-bit-up': '\u22658位',
      'precision.short.full-width': 'FP16+',
      'precision.error': '无法设置精度下限：{message}',

      'recent.caption': '最近请求',
      'recent.hint': '按时间倒序显示最近的中继请求。',
      'recent.column.tier': '预设',
      'recent.column.model': '模型',
      'recent.column.status': '状态',
      'recent.column.ms': '耗时',
      'recent.column.tokens': 'Token 数',
      'recent.empty': '中继尚未转发任何请求。',
      'recent.stream': '流式',
      'recent.streamTitle': '流式响应',
      'recent.bytesTitle': '未读取到用量；已传输 {bytes} 字节',

      'usage.title': 'OpenRouter',
      'usage.openAria': 'OpenRouter {today}',
      'usage.today': '今日',
      'usage.total': '累计',
      'usage.tabsLabel': '用量详情分区',
      'usage.tab.models': '模型',
      'usage.tab.requests': '请求',
      'usage.tab.presets': '预设',
      'usage.tab.sessions': '会话',
      'usage.dialogTitle': 'OpenRouter 用量',
      'usage.close': '关闭',
      'usage.byTier': '按预设计费',
      'usage.byTierEmpty': '本次进程中尚无按预设产生的费用。',
      'usage.requests': '{count} 次请求',
      'usage.empty': '今日尚无报告了模型的请求。',
      'usage.tokensLine': '输入 {input} · 缓存 {cache} · 输出 {output}',
      'usage.tokensTitle': '输入 {input} · 缓存读取 {cacheRead} · 缓存写入 {cacheWrite} · 输出 {output}',
      'usage.column.time': '时间',
      'usage.column.provider': '服务商',
      'usage.column.session': '会话',
      'usage.column.sessionName': '名称',
      'usage.column.input': '输入',
      'usage.column.cacheRead': '缓存读取',
      'usage.column.cacheWrite': '缓存写入',
      'usage.column.output': '输出',
      'usage.column.requests': '请求数',
      'usage.totalsRow': '合计',
      'usage.sessionsEmpty': '本次进程中尚无按会话计费的记录。',
      'usage.column.cost': '费用',
      'usage.column.stream': '流式',
      'usage.rowDetailAria': '{time} 请求的原始字段',
      'usage.servedAs': '实际 {tier}',
      'usage.rawFields': 'OpenRouter 原始字段',
      'usage.servedModel': '实际服务模型',
      'usage.servedTier': '实际服务等级',
      'usage.byok': 'BYOK',
      'usage.byokNote': 'BYOK 时上游那一段由你自己的提供商密钥付费：下面两笔金额是各自的收费，不能相加。',
      'usage.yes': '是',
      'usage.no': '否',
      'usage.costDetails': '费用明细',
      'usage.costTotal': 'OpenRouter 收取',
      'usage.costUpstream': '你的提供商密钥付费',
      'usage.costPrompt': '输入',
      'usage.costCompletion': '输出',
      'usage.costTool': '工具',
      'usage.genId': '生成 ID',
      'usage.notReported': '未报告',
      'usage.usd': '${value}',
      'usage.toggleSettings': '在侧边栏显示费用卡片',
      'usage.toggleHint': '侧边栏底部会显示可折叠的费用卡片，包含今日花费与使用的模型。开启会重新加载中继。',
      'usage.toggleFailed': '无法修改侧边栏卡片：{message}',
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

    /**
     * A USD amount, or null for anything that is not a finite number.
     *
     * Two decimals keep a money column aligned; up to six keep a per-request cost from
     * rounding away, because OpenRouter bills fractions of a cent. `Intl.NumberFormat`
     * supplies the reader's own grouping and decimal separators.
     */
    function formatUsd(value) {
      const number = finiteNumber(value);
      if (number === null) return null;
      try {
        return new Intl.NumberFormat(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        }).format(number);
      } catch (error) {
        return number.toFixed(2);
      }
    }

    /**
     * Money for a row. A missing amount is "not reported", never `$0`: a failed call or a
     * stream aborted before its usage chunk has no billed amount, and zero would be a claim
     * that nothing was spent.
     */
    function usdText(t, value) {
      const amount = formatUsd(value);
      return amount === null ? t('usage.notReported') : t('usage.usd', { value: amount });
    }

    /** Compact token counts for a one-line summary: 8500000 → "8.5M". */
    function compactTokens(value) {
      const number = finiteNumber(value);
      if (number === null) return '0';
      const magnitude = Math.abs(number);
      if (magnitude < 1000) return formatCount(number);
      const scaled = (divisor, suffix) => {
        const fixed = (number / divisor).toFixed(1);
        return (fixed.slice(-2) === '.0' ? fixed.slice(0, -2) : fixed) + suffix;
      };
      if (magnitude >= 1e9) return scaled(1e9, 'B');
      if (magnitude >= 1e6) return scaled(1e6, 'M');
      return scaled(1e3, 'K');
    }

    /**
     * Fixed HH:MM:SS in local time. `localTime` keeps the settings page's locale-formatted
     * stamp; the details dialog's time column wants the same width on every row instead.
     */
    function clockTime(value) {
      const stamp =
        typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : NaN;
      if (!Number.isFinite(stamp)) return '';
      try {
        const date = new Date(stamp);
        if (!Number.isFinite(date.getTime())) return '';
        const pad = (part) => String(part).padStart(2, '0');
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
      } catch (error) {
        return '';
      }
    }

    /**
     * A tier bucket's label. Buckets are keyed by the wire tier that was sent, so they use
     * the older vocabulary (`default`, `ultrafast`, `unset`) and are mapped onto the preset
     * labels the rest of this plugin shows; an unknown name stands for itself.
     */
    function usageTierLabel(t, tier) {
      const text = stringValue(tier).trim();
      if (text === '' || text === 'unset') return t('preset.none');
      const preset = presetFromLegacyTier(text);
      return preset === null ? text : t('preset.' + preset);
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

    function errorMessage(t, error) {
      if (error && error.name === 'AbortError') {
        return t('offline.timeout', { seconds: String(STATUS_TIMEOUT_MS / 1000) });
      }
      if (error && typeof error.message === 'string' && error.message.trim() !== '') {
        return error.message.trim();
      }
      return t('offline.noReason');
    }

    /**
     * User text for a write whose outcome is unknown. A cut response is not a timeout: the
     * relay may well have applied the write, so the message says so and leaves the next
     * probe to decide — the same posture as the provider-row strip.
     */
    function unknownOutcomeMessage(t, error) {
      if (error && error.name === 'AbortError') return t('strip.stalled');
      return errorMessage(t, error);
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

    /**
     * `/tier` bodies, normalised: `chosen` is the preset the Session picked (null while
     * it follows the profile default), `preset` what a request will carry, `default` the
     * configured fallback. Null means the Host answered something that is not this API.
     */
    function normalizePresetState(payload) {
      if (!isPlainObject(payload)) return null;
      if (payload.ok === false) return null;
      /* `preset` is the current answer; a relay that still speaks tiers answers `tier`, and a
         client showing "the relay did not confirm" while the change *was* applied is a
         worse failure than reading the older field, so both are accepted. */
      const modern = Object.prototype.hasOwnProperty.call(payload, 'preset');
      if (!modern && !Object.prototype.hasOwnProperty.call(payload, 'tier')) return null;
      const chosen = presetFromLegacyTier(payload.chosen);
      const fallback = presetFromLegacyTier(payload.default) ?? 'none';
      const effective = presetFromLegacyTier(payload.preset ?? payload.tier) ?? 'none';
      return { chosen: chosen, default: fallback, preset: effective };
    }

    /** A precision floor as the vocabulary spells it; anything else reads as `any`. */
    function precisionFloorOf(value) {
      const text = stringValue(value).trim().toLowerCase();
      return PRECISION_FLOORS.includes(text) ? text : 'any';
    }

    /** The relay's unknown-precision default for a floor; see `PRECISION_UNKNOWN_DEFAULT`. */
    function precisionIncludeUnknownDefault(floor) {
      return PRECISION_UNKNOWN_DEFAULT[floor] === true;
    }

    /** `{ floor, includeUnknown }` from a menu row, a payload field or the bare floor id. */
    function normalizePrecisionChoice(raw) {
      const floor = precisionFloorOf(isPlainObject(raw) ? raw.floor : raw);
      const declared = isPlainObject(raw) ? raw.includeUnknown : undefined;
      return {
        floor: floor,
        includeUnknown:
          typeof declared === 'boolean' ? declared : precisionIncludeUnknownDefault(floor),
      };
    }

    /** `allow` is the materialised wire list; `null` for `any`, which is "sends nothing". */
    function normalizePrecisionAllow(value) {
      if (!Array.isArray(value)) return null;
      const levels = value
        .filter((level) => typeof level === 'string' && level.trim() !== '')
        .map((level) => level.trim());
      return levels.length === 0 ? null : levels;
    }

    /**
     * `/precision` bodies, normalised: `floor` is the current choice, `includeUnknown`
     * whether endpoints that declare nothing stay eligible, `allow` the wire list the relay
     * would send (`null` on `any`). Null means the Host answered something that is not this
     * API, and the chip then keeps the badge it shipped with instead of breaking.
     */
    function normalizePrecisionState(payload) {
      if (!isPlainObject(payload)) return null;
      if (payload.ok === false) return null;
      if (!isPlainObject(payload.precision)) return null;
      const choice = normalizePrecisionChoice(payload.precision);
      return {
        floor: choice.floor,
        includeUnknown: choice.includeUnknown,
        allow: normalizePrecisionAllow(payload.precision.allow),
        inherited: payload.inherited === true,
        source: payload.source === 'session' ? 'session' : 'default',
      };
    }

    /**
     * The POST body. A floor change carries that floor's own unknown-precision default:
     * the popover has one power switch, not two, so the default is the honest value to
     * send and the read-back settles whatever the profile prefers.
     */
    function precisionPostBody(sessionId, floor) {
      const known = precisionFloorOf(floor);
      return {
        session: sessionId,
        precision: { floor: known, includeUnknown: precisionIncludeUnknownDefault(known) },
      };
    }

    /** The collapsed badge's second half; empty for `any`, which keeps the chip as released. */
    function precisionShortLabel(t, floor) {
      const known = precisionFloorOf(floor);
      return known === 'any' ? '' : t('precision.short.' + known);
    }

    /** `<preset label> · <precision short label>`, or the preset label alone for `any`. */
    function chipBadgeLabel(t, presetLabel, precision) {
      const parts = chipBadgeParts(t, presetLabel, precision);
      return parts.precision === '' ? parts.label : parts.label + ' ' + parts.precision;
    }

    /**
     * The two halves of the collapsed trigger, kept apart so the renderer can paint the floor in
     * the caption tone without re-parsing it out of a joined string: `Standard  ≥8-bit`, the way
     * the model seat prints "model  effort". `any` yields no precision half at all, so an
     * unconfigured chip still reads exactly as the preset label alone.
     */
    function chipBadgeParts(t, presetLabel, precision) {
      return {
        label: presetLabel,
        precision: precisionShortLabel(t, isPlainObject(precision) ? precision.floor : 'any'),
      };
    }

    /**
     * One drilled pane's rows: the preset list, or the floor list. A pane is one listbox of
     * options either way, which is why the two share a renderer and a row component.
     */
    function chipFacetRows(t, facet, view) {
      if (facet === 'precision') {
        return PRECISION_FLOORS.map((floor) => ({
          value: floor,
          key: floor,
          label: t('precision.row.' + floor),
          hint:
            floor === 'any'
              ? t('precision.row.any.hint')
              : t('precision.wireLevels', {
                  levels: PRECISION_WIRE_LEVELS[floor].join(', '),
                }),
          selected: floor === view.precisionFloor,
        }));
      }
      return [
        {
          value: '',
          key: 'inherit',
          label: t('preset.inherit', { preset: view.presetLabel(view.profileDefault) }),
          hint: '',
          selected: view.chosenPreset === '',
        },
      ].concat(
        PRESET_IDS.map((id) => ({
          value: id,
          key: id,
          label: view.presetLabel(id),
          hint: '',
          selected: id === view.chosenPreset,
        })),
      );
    }

    /**
     * The root pane's cells, in the frozen order: Tier first, Precision second. Each states
     * what the Session currently runs on — the preset label, and the floor's short label
     * (`Any` when nothing is filtered) — because the cell is the only place both values are
     * visible before a drill-in.
     *
     * `view`: `{ presetLabel, activePreset, switchingPreset, floor }`.
     */
    function chipRootCells(t, view) {
      const tierLabel = t('chip.facet.tier');
      const precisionLabel = t('chip.facet.precision');
      const tierValue =
        view.switchingPreset === true ? t('tier.switching') : view.presetLabel(view.activePreset);
      const floor = precisionFloorOf(view.floor);
      const precisionValue =
        floor === 'any' ? t('precision.row.any') : precisionShortLabel(t, floor);
      return [
        {
          facet: 'tier',
          label: tierLabel,
          value: tierValue,
          ariaLabel: t('chip.cellAria', { label: tierLabel, value: tierValue }),
        },
        {
          facet: 'precision',
          label: precisionLabel,
          value: precisionValue,
          ariaLabel: t('chip.cellAria', { label: precisionLabel, value: precisionValue }),
        },
      ];
    }

    /**
     * The keyboard ladder of the two-level menu: Escape and Shift+Tab leave a drilled pane
     * for the root one, and from the root pane they close the popover. Returns the pane to
     * show, or null for "close"; every other key leaves the pane alone.
     */
    function chipPaneAfterKey(pane, key, shiftKey) {
      if (key !== 'Escape' && !(key === 'Tab' && shiftKey === true)) return pane;
      return pane === CHIP_PANE_ROOT ? null : CHIP_PANE_ROOT;
    }


    /**
     * The preset table a picker renders. `/targets` carries `tier: { default, presets }`;
     * anything else (an older relay, a half-read response) degrades to the built-in list
     * rather than throwing the settings page out of its error boundary.
     */
    function normalizePresetTable(value) {
      const table = isPlainObject(value) ? value : {};
      const advertised = Array.isArray(table.presets) ? table.presets : [];
      const presets = advertised.filter(
        (id) => typeof id === 'string' && PRESET_IDS.includes(id),
      );
      const known = presets.length > 0 ? presets : PRESET_IDS.slice();
      const fallback = presetFromLegacyTier(table.default) ?? 'none';
      return {
        presets: known,
        default: known.includes(fallback) ? fallback : known[0],
      };
    }

    /** A control-route failure message, from either envelope this plugin has shipped. */
    function controlErrorMessage(payload, fallback) {
      const nested = payloadErrorMessage(payload);
      if (nested !== '') return nested;
      if (isPlainObject(payload)) {
        const flat = stringValue(payload.error).trim();
        if (flat !== '') return flat;
      }
      return fallback;
    }

    /**
     * The first candidate that names both a provider and a model, normalised to the three
     * fields a selection carries. Composer seats read the durable projection and the shared
     * `ModelDirectory` in a fixed order; this collapses that list to one truth so the chip
     * has a single `selection` to badge and to submit, effort included.
     */
    function firstSelection(candidates) {
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!isPlainObject(candidate)) continue;
        const provider = stringValue(candidate.provider).trim();
        const model = stringValue(candidate.model).trim();
        if (provider === '' || model === '') continue;
        const effort = stringValue(candidate.reasoningEffort).trim();
        return effort === '' ? { provider: provider, model: model } : { provider: provider, model: model, reasoningEffort: effort };
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
      /* The recent table shows a preset, not the wire tier, because a sort preset sends no
         tier at all; the Host reports the outcome a person picked beside the raw field. */
      const preset = stringValue(rawEntry.preset).trim();
      const statusNumber = finiteNumber(rawEntry.status);
      const statusText = stringValue(rawEntry.status).trim();
      return {
        at,
        tier: tier === '' ? null : tier,
        preset: preset === '' ? null : preset,
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
        mounts.push({
          path,
          tier,
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
     * One row per routing outcome, on the mount that pins it. The relay keeps serving the
     * older names — `/auto/v1` asks for the same thing as `/v1`, `/fast/v1` predates
     * `priority`, and `/scale/v1` names a tier no endpoint honours — but listing an alias
     * beside its canonical sibling offers one pin three times over.
     */
    function pinnedMounts(mounts) {
      const canonical = [
        ['none', null],
        ['standard', 'default'],
        ['flex', 'flex'],
        ['priority', 'priority'],
        ['ultra', 'ultrafast'],
      ];
      const rows = [];
      for (const entry of canonical) {
        const mount = mounts.find((candidate) => candidate.tier === entry[1]);
        if (mount !== undefined) rows.push({ preset: entry[0], mount: mount });
      }
      return rows;
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
          costUsd: finiteNumber(entry.costUsd),
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
        /* The sidebar card's flag. `available` keeps "this Host has no such preference"
           apart from "it is off", so the settings page does not offer a checkbox that no
           endpoint would answer. */
        usageWidget: {
          available: isPlainObject(payload.usageWidget),
          enabled: isPlainObject(payload.usageWidget) && payload.usageWidget.enabled === true,
        },
        mounts: normalizeMounts(payload.routes, byTier),
        metrics: {
          startedAt: stringValue(payload.metrics.startedAt),
          requests: countNumber(payload.metrics.requests),
          errors: countNumber(payload.metrics.errors),
          streamingRequests: countNumber(payload.metrics.streamingRequests),
          promptTokens: countNumber(payload.metrics.promptTokens),
          completionTokens: countNumber(payload.metrics.completionTokens),
          bytes: countNumber(payload.metrics.bytes),
          // Money, not the multiplier weight; null means the Host predates the field and
          // the page then simply omits the cost rows instead of printing $0.
          costUsd: finiteNumber(payload.metrics.costUsd),
          todayUsd: finiteNumber(payload.metrics.todayUsd),
          byTier,
          effectiveMultiplier: finiteNumber(payload.metrics.effectiveMultiplier),
          recent,
        },
      };
    }

    /**
     * One recent relayed request, as the details dialog shows it.
     *
     * Cost stays nullable: a failed call, or a stream the caller aborted before the usage
     * chunk, has no billed amount, and printing `$0` would claim the call was free. The raw
     * OpenRouter fields come from the envelope the Host sniffs; a Host that predates one of
     * them leaves it empty and the dialog says "not reported" instead of inventing a value.
     * A cost is read under the Host row's name, the relay sniffer's own name or the wire's
     * snake_case `cost_details` key, because either half may forward what the other named.
     */
    function normalizeUsageRecent(rawEntry) {
      if (!isPlainObject(rawEntry)) return null;
      const details = isPlainObject(rawEntry.costDetails)
        ? rawEntry.costDetails
        : isPlainObject(rawEntry.cost_details)
          ? rawEntry.cost_details
          : null;
      const money = (fields, wire) => {
        for (const field of fields) {
          const direct = finiteNumber(rawEntry[field]);
          if (direct !== null) return direct;
        }
        return details === null ? null : finiteNumber(details[wire]);
      };
      const preset = stringValue(rawEntry.preset).trim();
      const tier = stringValue(rawEntry.tier).trim();
      return {
        at: finiteNumber(rawEntry.at),
        tier: tier === '' ? null : tier,
        preset: preset === '' ? null : preset,
        model: stringValue(rawEntry.model).trim(),
        servedModel: stringValue(rawEntry.servedModel).trim(),
        servedTier: stringValue(rawEntry.servedTier).trim(),
        /* The upstream that answered, and the session the call belonged to: both are on
           every relayed request, and both are what makes the Requests/Sessions tabs useful. */
        providerName: stringValue(rawEntry.providerName).trim(),
        sessionId: stringValue(rawEntry.sessionId).trim(),
        sessionTitle: stringValue(rawEntry.sessionTitle).trim(),
        status: finiteNumber(rawEntry.status),
        ms: finiteNumber(rawEntry.ms),
        streaming: rawEntry.streaming === true,
        promptTokens: finiteNumber(rawEntry.promptTokens),
        completionTokens: finiteNumber(rawEntry.completionTokens),
        cacheReadTokens: finiteNumber(rawEntry.cacheReadTokens),
        cacheWriteTokens: finiteNumber(rawEntry.cacheWriteTokens),
        costUsd: finiteNumber(rawEntry.costUsd),
        // The upstream leg is what the caller's own provider key was billed when OpenRouter
        // passed the call through (BYOK). It is a separate charge from `costUsd`, never a
        // part of it, so the two are shown apart and never added.
        upstreamCostUsd: money(['upstreamCostUsd'], 'upstream_inference_cost'),
        promptCostUsd: money(['promptCostUsd', 'upstreamPromptCostUsd'], 'upstream_inference_prompt_cost'),
        completionCostUsd: money(
          ['completionCostUsd', 'upstreamCompletionCostUsd'],
          'upstream_inference_completions_cost',
        ),
        toolCostUsd: money(['serverToolCostUsd'], 'server_tool_cost'),
        byok: rawEntry.byok === true,
        genId: stringValue(rawEntry.genId).trim(),
      };
    }

    /**
     * The sidebar card's own reading of `/status`.
     *
     * Null means "draw nothing", and one check per refusal: the feature is off
     * (`usageWidget.enabled`), the relay owns no socket (`bound`), or the Host predates the
     * money fields (`metrics.costUsd`). A card in the sidebar has no room to explain a
     * guess, so an older Host simply shows no card.
     */
    function normalizeUsageStatus(payload) {
      if (!isPlainObject(payload)) return null;
      if (payload.ok === false) return null;
      if (payload.bound !== true) return null;
      if (!isPlainObject(payload.usageWidget)) return null;
      if (payload.usageWidget.enabled !== true) return null;
      if (!isPlainObject(payload.metrics)) return null;
      const totalUsd = finiteNumber(payload.metrics.costUsd);
      if (totalUsd === null) return null;

      /* Today's models, already sorted by spend; the card draws the same order. A row
         without a model name (a failed call before routing) has nothing to label. */
      const byModel = [];
      const byModelSource = Array.isArray(payload.metrics.byModel) ? payload.metrics.byModel : [];
      for (const entry of byModelSource) {
        if (!isPlainObject(entry)) continue;
        const model = stringValue(entry.model).trim();
        if (model === '') continue;
        byModel.push({
          model,
          requests: countNumber(entry.requests),
          promptTokens: countNumber(entry.promptTokens),
          completionTokens: countNumber(entry.completionTokens),
          cacheReadTokens: countNumber(entry.cacheReadTokens),
          cacheWriteTokens: countNumber(entry.cacheWriteTokens),
          costUsd: finiteNumber(entry.costUsd),
        });
      }

      /* Per-tier buckets are process-local, so they can be empty right after a Host reload
         while the retained day totals still carry money; an empty table is then correct. */
      const byTier = [];
      const byTierSource = isPlainObject(payload.metrics.byTier) ? payload.metrics.byTier : {};
      for (const key of Object.keys(byTierSource)) {
        const entry = byTierSource[key];
        if (!isPlainObject(entry)) continue;
        const requests = countNumber(entry.requests);
        if (requests === 0) continue;
        byTier.push({
          tier: key,
          requests,
          costUsd: finiteNumber(entry.costUsd),
          multiplier: finiteNumber(entry.multiplier),
        });
      }
      byTier.sort((left, right) => {
        const leftCost = left.costUsd === null ? 0 : left.costUsd;
        const rightCost = right.costUsd === null ? 0 : right.costUsd;
        if (rightCost !== leftCost) return rightCost - leftCost;
        return left.tier < right.tier ? -1 : left.tier > right.tier ? 1 : 0;
      });

      const recent = [];
      const recentSource = Array.isArray(payload.metrics.recent) ? payload.metrics.recent : [];
      for (const entry of recentSource) {
        if (recent.length >= USAGE_RECENT_LIMIT) break;
        const normalized = normalizeUsageRecent(entry);
        if (normalized !== null) recent.push(normalized);
      }

      /* Cost per session, already ordered by spend by the Host. Process-local, like the
         per-tier buckets: a Host reload empties it while the day totals still carry money. */
      const bySession = [];
      const bySessionSource = Array.isArray(payload.metrics.bySession) ? payload.metrics.bySession : [];
      for (const entry of bySessionSource) {
        if (!isPlainObject(entry)) continue;
        const session = stringValue(entry.session).trim();
        if (session === '') continue;
        bySession.push({
          session,
          requests: countNumber(entry.requests),
          promptTokens: countNumber(entry.promptTokens),
          completionTokens: countNumber(entry.completionTokens),
          costUsd: finiteNumber(entry.costUsd),
          lastAt: finiteNumber(entry.lastAt),
          title: stringValue(entry.title).trim(),
        });
      }

      return {
        /* A partial Host can report the total without today; the card then says "not
           reported" for the day rather than $0.00. */
        todayUsd: finiteNumber(payload.metrics.todayUsd),
        totalUsd,
        byModel,
        byTier,
        bySession,
        recent,
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
            /* The per-endpoint target this row mounts, when the relay mounted one. It is
               the family key shared by every tier sibling, and the composer chip refuses
               to retier a row without it (a plain upstream link has no tier family). */
            targetId: stringValue(entry.targetId).trim(),
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

      /* The tier table: which tiers a Session may pick, and the one an unchosen
         Session inherits. Absent on an older Host, so both halves stay optional. */
      let tierDefault = null;
      let tiers = [];
      if (isPlainObject(payload.tier)) {
        const fallback = stringValue(payload.tier.default).trim();
        tierDefault = fallback === '' ? null : fallback;
        if (Array.isArray(payload.tier.tiers)) {
          for (const level of payload.tier.tiers) {
            const name = stringValue(level).trim();
            if (name !== '' && tiers.indexOf(name) === -1) tiers.push(name);
          }
        }
      }

      return {
        available: payload.available !== false,
        reason: stringValue(payload.reason).trim(),
        sources,
        created,
        custom,
        reasoning,
        tier: { default: tierDefault, tiers: tiers },
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

    /* A route can point at an endpoint reporting hundreds of models; render a window
       and let the filter do the work rather than mounting them all. */
    const PICKER_LIMIT = 150;

    const COLORS = {
      primary: 'var(--dsw-alias-label-primary, CanvasText)',
      secondary: 'var(--dsw-alias-label-secondary, GrayText)',
      tertiary: 'var(--dsw-alias-label-tertiary, GrayText)',
      // The quieter tone the shell prints the second half of a compound control in: the composer's
      // model seat writes its effort this way, so the routing chip writes its floor the same way.
      caption: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, GrayText))',
      border: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2))',
      layerTwo: 'var(--dsw-alias-bg-layer-2, ButtonFace)',
      success: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      error: 'var(--dsw-alias-state-error-primary, #c92a2a)',
      warn: 'var(--dsw-alias-state-warn-primary, #b08800)',
      brand: 'var(--dsw-alias-brand-primary, Highlight)',
      fill: 'var(--dsw-alias-fill-l1, rgba(0, 0, 0, 0.06))',
      // The modal scrim the shell paints behind its own dialogs, so the overlay dims with
      // the theme instead of a fixed black that the light theme would over-darken.
      mask: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.42))',
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

    /** The settings page's preset table: label above, explanation below. */
    const PRESET_GRID_STYLE = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: '8px 18px',
      minWidth: 0,
      padding: '6px 0',
      borderTop: '1px solid ' + COLORS.border,
    };

    const PRESET_ENTRY_STYLE = { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 };

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

    const STRIP_HINT_STYLE = { margin: 0, flexBasis: '100%', color: COLORS.secondary, font: FONTS.tiny };

    /* The live-model row sits under the routing switch on the same card. */
    const STRIP_ACTIONS_STYLE = {
      display: 'inline-flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
    };

    /* The model picker needs a real surface: a long scrollable list plus a filter. */
    const STRIP_PICKER_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      flexBasis: '100%',
      minWidth: 0,
      padding: '8px',
      border: '1px solid ' + COLORS.border,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: COLORS.layerTwo,
    };

    const PICKER_FILTER_STYLE = {
      margin: 0,
      padding: '3px 8px',
      minHeight: '24px',
      boxSizing: 'border-box',
      border: '1px solid ' + COLORS.borderStrong,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: COLORS.primary === '' ? undefined : 'transparent',
      color: COLORS.primary,
      font: FONTS.small,
      width: '100%',
    };

    const PICKER_LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      maxHeight: '240px',
      overflowY: 'auto',
    };

    const PICKER_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '2px 4px',
      minWidth: 0,
      color: COLORS.primary,
      font: FONTS.tiny,
      cursor: 'pointer',
    };

    /* An id the route already declares: visible, but not an invitation to add it. */
    const PICKER_ROW_ADDED_STYLE = { ...PICKER_ROW_STYLE, color: COLORS.secondary, cursor: 'default' };

    /* A model ticked off the route: still listed, visibly on its way out. */
    const PICKER_ROW_REMOVING_STYLE = { ...PICKER_ROW_STYLE, color: COLORS.error, textDecoration: 'line-through' };

    const PICKER_REMOVE_BADGE_STYLE = {
      flex: '0 0 auto',
      marginLeft: 'auto',
      padding: '0 6px',
      borderRadius: '999px',
      border: '1px solid ' + COLORS.error,
      color: COLORS.error,
      font: FONTS.tiny,
      textDecoration: 'none',
    };

    const PICKER_BADGE_STYLE = {
      flex: '0 0 auto',
      marginLeft: 'auto',
      padding: '0 6px',
      borderRadius: '999px',
      border: '1px solid ' + COLORS.border,
      color: COLORS.secondary,
      font: FONTS.tiny,
    };

    /* Composer chip: 24px tall to sit on the composer's 28px control row without
       pushing it, and it never grows past the space the row has for it. */
    function chipStyle(state) {
      const disabled = state.disabled === true;
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
        maxWidth: 'min(190px, 40vw)',
        height: '24px',
        margin: 0,
        padding: '0 6px',
        boxSizing: 'border-box',
        border: '1px solid ' + COLORS.border,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background:
          state.open || state.hovered
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))'
            : 'transparent',
        color: COLORS.secondary,
        font: FONTS.tiny,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'progress' : 'pointer',
        opacity: disabled ? 0.7 : 1,
        outline: state.focused ? '2px solid ' + COLORS.brand : 'none',
        outlineOffset: '2px',
        appearance: 'none',
        WebkitAppearance: 'none',
      };
    }

    const CHIP_TEXT_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };

    /**
     * The floor half of the collapsed badge, in the shell's caption tone. The model seat prints
     * its effort the same way (`_7KE1Ra_triggerEffort`), so the two composer chips read as one
     * family. It gives up width before the preset name does, which is why it alone carries the
     * large `flexShrink`; the trigger's own `gap: 4px` supplies the space between the halves.
     */
    const CHIP_PRECISION_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flexShrink: 1000,
      color: COLORS.caption,
    };

    const CHIP_CARET_STYLE = { flex: '0 0 auto', color: COLORS.tertiary, font: FONTS.tiny };

    const CHIP_HINT_STYLE = {
      margin: '2px 4px 0',
      color: COLORS.secondary,
      font: FONTS.tiny,
      whiteSpace: 'normal',
    };

    function chipOptionStyle(state) {
      const disabled = state.disabled === true;
      const selected = state.selected === true;
      /* A precision row carries a second line, so it wraps; a preset row is one line and
         must stay exactly as tall as it shipped. */
      const wrapped = state.wrapped === true;
      return {
        display: 'flex',
        alignItems: wrapped ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: '8px',
        margin: 0,
        padding: '3px 8px',
        minHeight: '24px',
        boxSizing: 'border-box',
        border: '1px solid transparent',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background:
          state.hovered && !disabled
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))'
            : selected
              ? COLORS.fill
              : 'transparent',
        color: COLORS.primary,
        font: selected ? FONTS.smallStrong : FONTS.small,
        lineHeight: '18px',
        textAlign: 'left',
        whiteSpace: wrapped ? 'normal' : 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        outline: 'none',
        appearance: 'none',
        WebkitAppearance: 'none',
      };
    }

    /*
     * The two-level menu, after the composer model picker: a root pane of full-width cells
     * (label left, the current value in tertiary tone right, a chevron to the drill-in
     * list), and one listbox pane below it. No tab strip: the cells are the navigation.
     */
    const CHIP_PANE_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
    };
    const CHIP_LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
    };

    /** One root cell: 34px, full width, label then value then chevron, hover-tinted. */
    function chipCellStyle(state) {
      const active = state.hovered === true || state.focused === true;
      return {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        boxSizing: 'border-box',
        width: 'auto',
        minWidth: '100%',
        height: '34px',
        margin: '0',
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: active
          ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))'
          : 'transparent',
        color: COLORS.primary,
        font: FONTS.small,
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        appearance: 'none',
        WebkitAppearance: 'none',
      };
    }

    const CHIP_CELL_LABEL_STYLE = { flex: '0 0 auto', whiteSpace: 'nowrap' };

    /* The current value, in the tertiary tone the model picker uses for it. */
    const CHIP_CELL_VALUE_STYLE = {
      flex: 'auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      textAlign: 'right',
      color: COLORS.tertiary,
    };

    const CHIP_CELL_CHEVRON_STYLE = { flex: '0 0 auto', color: COLORS.tertiary, font: FONTS.tiny };

    /* A precision row's second line: the wire levels it admits, so the trade is legible
       before it is chosen rather than after a bill. */
    const CHIP_OPTION_STACK_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      minWidth: 0,
      textAlign: 'left',
    };
    const CHIP_OPTION_HINT_STYLE = {
      color: COLORS.secondary,
      font: FONTS.tiny,
      lineHeight: '15px',
      whiteSpace: 'normal',
    };

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

    /* -------------------------------------------------------------- usage styles */

    /*
     * The sidebar spend card and its dialog. Inline styles over the shell's tokens only:
     * the card lives in a narrow column the sidebar owns, so it brings no stylesheet and
     * no class names of its own, and nothing here touches the document root.
     */
    const USAGE_CARD_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      minWidth: 0,
      boxSizing: 'border-box',
      border: '1px solid ' + COLORS.border,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: COLORS.layerTwo,
      overflow: 'hidden',
    };

    function usageHeaderStyle(state) {
      return {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        margin: 0,
        padding: '4px 8px',
        minHeight: '26px',
        boxSizing: 'border-box',
        border: 0,
        borderRadius: 0,
        background: state.hovered ? COLORS.fill : 'transparent',
        color: COLORS.primary,
        font: FONTS.small,
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
        outline: state.focused ? '2px solid ' + COLORS.brand : 'none',
        outlineOffset: '-2px',
        appearance: 'none',
        WebkitAppearance: 'none',
      };
    }

    const USAGE_CHEVRON_STYLE = { flex: '0 0 auto', color: COLORS.tertiary, font: FONTS.tiny };

    const USAGE_TITLE_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: COLORS.primary,
      font: FONTS.smallStrong,
    };

    const USAGE_AMOUNT_STYLE = {
      flex: '0 0 auto',
      color: COLORS.primary,
      font: FONTS.smallStrong,
      fontVariantNumeric: 'tabular-nums',
    };

    const USAGE_MODEL_LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      margin: 0,
      padding: 0,
      listStyle: 'none',
      minWidth: 0,
    };

    const USAGE_MODEL_HEAD_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '8px',
      minWidth: 0,
    };

    const USAGE_MODEL_ROW_STYLE = { display: 'flex', flexDirection: 'column', minWidth: 0 };

    const USAGE_MODEL_NAME_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: COLORS.primary,
      font: FONTS.tiny,
    };

    const USAGE_MODEL_COST_STYLE = {
      flex: '0 0 auto',
      color: COLORS.primary,
      font: FONTS.tiny,
      fontVariantNumeric: 'tabular-nums',
    };

    const USAGE_MODEL_TOKENS_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: COLORS.secondary,
      font: FONTS.tiny,
    };

    const USAGE_EMPTY_STYLE = { color: COLORS.secondary, font: FONTS.tiny };

    /* The dialog's tab strip and the ids that tie each tab to the panel below it. */
    const USAGE_TAB_ID_PREFIX = 'usage-tab-';
    const USAGE_TAB_PANEL_ID = 'openrouter-plus-usage-panel';
    const USAGE_TAB_BAR_STYLE = {
      display: 'flex',
      gap: '2px',
      padding: '3px',
      alignSelf: 'flex-start',
      borderRadius: '8px',
      background: COLORS.fill,
      border: '1px solid ' + COLORS.border,
    };
    const USAGE_TAB_PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      minHeight: '96px',
    };

    /** One tab button: selected reads as a raised surface, not a colour-only signal. */
    const usageTabStyle = (active) => ({
      appearance: 'none',
      border: 0,
      margin: 0,
      padding: '4px 10px',
      borderRadius: '6px',
      cursor: 'pointer',
      font: active ? FONTS.smallStrong : FONTS.small,
      color: active ? COLORS.primary : COLORS.secondary,
      background: active ? COLORS.layerTwo : 'transparent',
      boxShadow: active ? '0 1px 2px rgba(0, 0, 0, 0.12)' : 'none',
    });

    /*
     * The dialog: a fixed overlay drawn inline. Nothing above the card creates a containing
     * block (the sidebar sets no transform), so `fixed` still means the viewport and the
     * backdrop covers the whole app without a portal.
     */
    const USAGE_OVERLAY_STYLE = {
      position: 'fixed',
      inset: 0,
      zIndex: 1200,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      boxSizing: 'border-box',
      background: COLORS.mask,
    };

    const USAGE_DIALOG_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: 'min(760px, 100%)',
      maxHeight: '85vh',
      boxSizing: 'border-box',
      padding: '16px',
      overflow: 'auto',
      outline: 'none',
      border: '1px solid ' + COLORS.borderStrong,
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      background: COLORS.layerTwo,
      boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.28))',
      color: COLORS.primary,
      font: FONTS.body,
      textAlign: 'left',
    };

    const USAGE_DIALOG_HEAD_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      minWidth: 0,
    };

    const USAGE_DIALOG_TITLE_STYLE = { margin: 0, color: COLORS.primary, font: FONTS.metric };

    const USAGE_SECTION_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: 0,
      paddingTop: '10px',
      borderTop: '1px solid ' + COLORS.border,
    };

    const USAGE_TIER_LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      margin: 0,
      padding: 0,
      listStyle: 'none',
      minWidth: 0,
    };

    const USAGE_TIER_BLOCK_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
    };

    const USAGE_TIER_ROW_STYLE = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '10px',
      minWidth: 0,
    };

    const USAGE_TIER_LABEL_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: COLORS.primary,
      font: FONTS.small,
    };

    const USAGE_TIER_META_STYLE = { flex: '0 0 auto', marginRight: 'auto', color: COLORS.secondary, font: FONTS.tiny };

    const USAGE_TIER_COST_STYLE = {
      flex: '0 0 auto',
      color: COLORS.primary,
      font: FONTS.small,
      fontVariantNumeric: 'tabular-nums',
    };

    /* Nine columns do not fit a phone; the dialog scrolls sideways rather than hiding a
       column, because every one of them is evidence about a bill. */
    const USAGE_TABLE_SCROLL_STYLE = { maxWidth: '100%', overflowX: 'auto' };
    const USAGE_TABLE_STYLE = { width: '100%', minWidth: '680px', borderCollapse: 'collapse' };

    const USAGE_RAW_STYLE = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: '6px 16px',
      minWidth: 0,
      padding: '8px',
      borderTop: '1px solid ' + COLORS.border,
    };

    const USAGE_RAW_LABEL_STYLE = { color: COLORS.secondary, font: FONTS.tiny };
    const USAGE_RAW_VALUE_STYLE = { color: COLORS.primary, font: FONTS.small, overflowWrap: 'anywhere' };
    const USAGE_RAW_HEADING_STYLE = {
      gridColumn: '1 / -1',
      color: COLORS.primary,
      font: FONTS.smallStrong,
      paddingTop: '2px',
    };
    const USAGE_RAW_NOTE_STYLE = { gridColumn: '1 / -1', margin: 0, color: COLORS.secondary, font: FONTS.tiny };

    /*
     * The row disclosure. No hover state: it is one button per row of a fifty-row table, and
     * the UA focus ring is left alone so keyboard focus is visible without tracking it.
     */
    const USAGE_TRIGGER_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '18px',
      height: '18px',
      margin: 0,
      padding: 0,
      border: 0,
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: COLORS.secondary,
      font: FONTS.tiny,
      lineHeight: '18px',
      cursor: 'pointer',
      appearance: 'none',
      WebkitAppearance: 'none',
    };

    const USAGE_TOGGLE_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      color: COLORS.primary,
      font: FONTS.small,
      cursor: 'pointer',
    };

    const USAGE_TOGGLE_ROW_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
      paddingTop: '4px',
    };

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

    /**
     * Which page chrome this seat draws.
     *
     * The same body answers two seats, and the frames around them are not the same height.
     * `settings.section` renders our page alone in the content column — the Settings shell
     * supplies no copy of its own — so the title and the one-line intro have to come from
     * here. `plugins.bundle.config` renders *inside* the bundle's Plugins page, which already
     * draws the package title, its version and its `package.json` description above the body;
     * repeating either would print "OpenRouter Plus" twice and say the same thing twice.
     *
     * Everything else — status, the relay/upstream line, mounts, counters, routes — is
     * identical in both seats, and that is the point of registering one body in two places.
     */
    function pageChrome(seat) {
      const inPlugins = seat === 'plugins';
      return { title: !inPlugins, intro: !inPlugins };
    }

    /**
     * The page body. Everything stateful lives here so the slot wrapper stays trivial and
     * unmounting the slot tears down every timer, fetch and listener this page owns.
     */
    function PageBody(props) {
      const t = props.t;
      const chrome = pageChrome(props.seat);

      /* One base, because the control API is mounted on this page's own origin. */
      const origin = CONTROL_BASE;
      const [connection, setConnection] = React.useState('checking');
      const [snapshot, setSnapshot] = React.useState(null);
      const [statusError, setStatusError] = React.useState('');
      const [refreshKey, setRefreshKey] = React.useState(0);
      const [targets, setTargets] = React.useState({ status: 'idle', data: null, error: '' });
      const [targetsKey, setTargetsKey] = React.useState(0);
      const [busy, setBusy] = React.useState(null);
      const [actionError, setActionError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [copyState, setCopyState] = React.useState(null);
      /* The sidebar card's switch is reported by `/status`, but its write reloads the plugin:
         the click's value is held here until the relay reports it back, so the checkbox does
         not appear to bounce while the reload settles. */
      const [widgetPending, setWidgetPending] = React.useState(null);
      const [widgetError, setWidgetError] = React.useState('');

      const mountedRef = React.useRef(true);
      const busyRef = React.useRef(null);
      const actionControllerRef = React.useRef(null);
      const noticeTimerRef = React.useRef(null);
      const copyTimerRef = React.useRef(null);
      const widgetTimerRef = React.useRef(null);

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
          if (widgetTimerRef.current !== null) {
            clearTimeout(widgetTimerRef.current);
            widgetTimerRef.current = null;
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

        const loadStatus = async () => {
          const response = await request(origin + controlUrl('/status'), STATUS_TIMEOUT_MS, {
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

        const tick = async () => {
          if (cancelled) return;
          try {
            const normalized = await loadStatus();
            if (cancelled) return;
            setSnapshot(normalized);
            setStatusError('');
            setConnection('online');
            /* The widget write reloads the plugin, so its flag can trail the response by a
               poll or two; the optimistic value stands until the relay reports it, and
               `WIDGET_SETTLE_MS` stops it from outliving a write that never landed. */
            setWidgetPending((pending) =>
              pending !== null && normalized.usageWidget.enabled === pending ? null : pending,
            );
          } catch (error) {
            if (cancelled) return;
            /* There is no second address to try: the API shares this page's origin, so a
               failure is the Host's — and when the Host answers with its own reason
               (`ok: false` plus `error`) that reason is what the banner shows.
               The last snapshot is kept, though: a plugin reload — a widget write, a route
               edit — fails this poll for a second or two, and blanking the page would throw
               away numbers that are still true. The next tick replaces it if it never
               comes back. */
            setStatusError(errorMessage(t, error));
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
      }, [refreshKey, t]);

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

      /* The tier every unchosen Session inherits. One profile-level preference, so it
         writes the plugin row (unlike a Session's choice, which is runtime state). */
      /*
       * Read back the profile default from the relay. It is a config write, so the Loader
       * re-applies this plugin's row and the POST's own response can be cut mid-rebind.
       * The answer that matters is in `/targets`, read again with small gaps because the
       * listener may still be coming back up.
       */
      const readDefaultTier = async (controller) => {
        for (let attempt = 0; attempt < RECONCILE_DELAYS_MS.length; attempt += 1) {
          await sleepUntil(RECONCILE_DELAYS_MS[attempt], controller === undefined ? null : controller.signal);
          if (!mountedRef.current) return null;
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/targets', {
              method: 'GET',
              mode: 'cors',
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            if (!response.ok) continue;
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            const normalized = normalizeTargets(payload);
            if (normalized !== null) return normalized;
          } catch (error) {
            /* Still rebinding: try the next gap. */
          }
        }
        return null;
      };

      /*
       * The profile-level default tier. Unlike the composer chip this one is a config
       * write, so it is the only tier action that can reload the plugin; the re-read
       * below decides between success and failure, exactly like the Models-page switch.
       */
      const runDefaultPreset = (preset) => {
        if (busy !== null || busyRef.current !== null) return;
        const controller = new AbortController();
        busyRef.current = 'tier-default';
        actionControllerRef.current = controller;
        setBusy({ kind: 'tier-default', key: 'tier-default' });
        setActionError('');
        setNotice('');
        (async () => {
          const wanted = preset;
          let failure = '';
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/tier/default', {
              method: 'POST',
              mode: 'cors',
              cache: 'no-store',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-oorp-client': CLIENT_HEADER,
              },
              body: JSON.stringify({ preset: preset }),
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
          } catch (error) {
            if (error && error.name === 'AbortError') return;
            failure = errorMessage(t, error);
          }

          const fresh = await readDefaultTier(controller);
          if (!mountedRef.current) return;
          if (fresh !== null) {
            const landed = fresh.tier === null ? null : fresh.tier.default;
            setTargets({ status: 'ready', data: fresh, error: '' });
            if (landed === wanted) failure = '';
          }
          busyRef.current = null;
          setBusy(null);
          if (actionControllerRef.current === controller) actionControllerRef.current = null;
          if (failure !== '') {
            setActionError(t('providers.actionFailed', { message: failure }));
            return;
          }
          setNotice(t('providers.noticeDefaultTier'));
          setTargetsKey((key) => key + 1);
          if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = setTimeout(() => {
            noticeTimerRef.current = null;
            if (mountedRef.current) setNotice('');
          }, NOTICE_MS);
        })();
      };

      /*
       * The sidebar card's own switch. It is a config write, so the relay reloads the plugin
       * to apply it and `/status` can fail — or still answer the old flag — for a second
       * afterwards. The click is held optimistically and the read-back decides; the page
       * keeps its snapshot through the reload, so nothing blanks while that settles.
       */
      const runWidgetToggle = (enabled) => {
        if (busy !== null || busyRef.current !== null) return;
        const controller = new AbortController();
        busyRef.current = 'widget';
        actionControllerRef.current = controller;
        setBusy({ kind: 'widget', key: 'widget' });
        setWidgetError('');
        setWidgetPending(enabled);
        /* The optimistic value is bounded: if the read-back never agrees — a write that
           never landed, a relay that stayed down — the next status answer wins over the
           click rather than the checkbox claiming a preference that was never saved. */
        if (widgetTimerRef.current !== null) {
          clearTimeout(widgetTimerRef.current);
          widgetTimerRef.current = null;
        }
        widgetTimerRef.current = setTimeout(() => {
          widgetTimerRef.current = null;
          if (mountedRef.current) setWidgetPending(null);
        }, WIDGET_SETTLE_MS);
        (async () => {
          /* Set only for an answer the relay actually gave: a cut connection is not a
             refusal, and a reload can cut it after the write landed. */
          let refused = false;
          try {
            const response = await fetch(origin + CONTROL_PREFIX + '/widget', {
              method: 'POST',
              mode: 'cors',
              cache: 'no-store',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-oorp-client': CLIENT_HEADER,
              },
              body: JSON.stringify({ enabled: enabled }),
              signal: controller.signal,
            });
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            if (!response.ok) {
              refused = true;
              throw new Error(payloadErrorMessage(payload) || t('error.http', { status: String(response.status) }));
            }
            if (!mountedRef.current) return;
            /* The write landed; the reload is the only thing left, so re-read now rather
               than after the interval. The click stands until the relay reports it. */
            setRefreshKey((key) => key + 1);
          } catch (error) {
            if (!mountedRef.current) return;
            if (refused) {
              setWidgetPending(null);
              setWidgetError(t('usage.toggleFailed', { message: errorMessage(t, error) }));
            }
            /* Otherwise the outcome is unknown: the config write may well have landed
               before the connection dropped, so the checkbox keeps the click and the next
               status answer is the truth. Saying "failed" here would be a guess. */
          } finally {
            if (mountedRef.current) {
              busyRef.current = null;
              setBusy(null);
            }
            if (actionControllerRef.current === controller) actionControllerRef.current = null;
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

      /* The relay's own address is the Host's business: it is where pi-ai sends
         requests, not where this page sends them. Unknown only if the payload
         predates the field. */
      const relayOrigin =
        snapshot !== null && snapshot.origin !== '' ? snapshot.origin : t('common.unknown');
      const upstreamHost = snapshot !== null ? hostOf(snapshot.upstream) : '';
      const mounts = snapshot !== null ? snapshot.mounts : [];
      const metrics = snapshot !== null ? snapshot.metrics : null;
      const totalTokens = metrics !== null ? metrics.promptTokens + metrics.completionTokens : 0;
      const byTier = metrics !== null ? metrics.byTier : {};

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

      /*
       * Money beside the counters. `costUsd` is what OpenRouter charged across the retained
       * window and `todayUsd` the local day in progress; both are read from each response's
       * own `usage.cost`, so nothing here is derived from a price table. A Host that predates
       * the fields reports null, and the block then shows only what it always did.
       */
      const hasCost = metrics !== null && metrics.costUsd !== null;
      const tierCosts = [];
      if (hasCost) {
        for (const tierKey of Object.keys(metrics.byTier)) {
          const bucket = metrics.byTier[tierKey];
          if (bucket.requests === 0) continue;
          tierCosts.push({ tier: tierKey, requests: bucket.requests, costUsd: bucket.costUsd });
        }
        /* Cost first, so the expensive preset is not lost at the bottom of a long list. */
        tierCosts.sort((left, right) => {
          const leftCost = left.costUsd === null ? 0 : left.costUsd;
          const rightCost = right.costUsd === null ? 0 : right.costUsd;
          if (rightCost !== leftCost) return rightCost - leftCost;
          return left.tier < right.tier ? -1 : left.tier > right.tier ? 1 : 0;
        });
      }

      /* ---------------------------------------------------------------- render helpers */

      const header = h(
        'header',
        { style: HEADER_STYLE },
        h(
          'div',
          { style: HEADER_ROW_STYLE },
          h('span', { style: dotStyle(connection), 'aria-hidden': 'true' }),
          chrome.title ? h('h2', { style: TITLE_STYLE }, t('card.title')) : null,
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
          h('p', { style: HINT_STYLE }, t('offline.hint')),
          h('div', null, h(ActionButton, { label: t('offline.retry'), onClick: retryConnection })),
        );

      const renderMounts = () => {
        const pinned = pinnedMounts(mounts);
        const rows =
          pinned.length === 0
            ? [
                h(
                  'tr',
                  { key: 'empty' },
                  h(
                    'td',
                    { colSpan: 5, style: Object.assign({}, TD_STYLE, { color: COLORS.secondary }) },
                    t('mounts.empty'),
                  ),
                ),
              ]
            : pinned.map((entry) => {
                const mount = entry.mount;
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
                    h('span', { style: BADGE_STYLE }, t('preset.' + entry.preset)),
                  ),
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
                h('th', { scope: 'col', style: TH_STYLE }, t('mounts.column.preset')),
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

      /*
       * The card's own switch, beside the numbers it produces. The Host answers it on the
       * same control API; a Host from before the preference reports `available: false` and
       * no checkbox is offered for an endpoint that would not answer.
       */
      const renderWidgetToggle = () => {
        if (snapshot === null || snapshot.usageWidget.available !== true) return null;
        const enabled = widgetPending === null ? snapshot.usageWidget.enabled : widgetPending;
        return h(
          'div',
          { style: USAGE_TOGGLE_ROW_STYLE },
          h(
            'label',
            { style: USAGE_TOGGLE_STYLE },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: busy !== null,
              onChange: (event) => runWidgetToggle(event.target.checked),
            }),
            h('span', null, t('usage.toggleSettings')),
          ),
          h('p', { style: HINT_STYLE }, t('usage.toggleHint')),
          widgetError !== '' ? h('p', { role: 'alert', style: ALERT_STYLE }, widgetError) : null,
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
            hasCost
              ? h(
                  'div',
                  { style: STAT_STYLE },
                  h('span', { style: STAT_LABEL_STYLE }, t('usage.today')),
                  h('span', { style: { font: FONTS.metric } }, usdText(t, metrics.todayUsd)),
                )
              : null,
            hasCost
              ? h(
                  'div',
                  { style: STAT_STYLE },
                  h('span', { style: STAT_LABEL_STYLE }, t('usage.total')),
                  h('span', { style: { font: FONTS.metric } }, usdText(t, metrics.costUsd)),
                )
              : null,
          ),
          tierCosts.length === 0
            ? null
            : h(
                'div',
                { style: USAGE_TIER_BLOCK_STYLE },
                h('span', { style: SUB_LABEL_STYLE }, t('usage.byTier')),
                h(
                  'ul',
                  { style: USAGE_TIER_LIST_STYLE },
                  tierCosts.map((row) =>
                    h(
                      'li',
                      { key: row.tier, style: USAGE_TIER_ROW_STYLE },
                      h('span', { style: USAGE_TIER_LABEL_STYLE }, usageTierLabel(t, row.tier)),
                      h(
                        'span',
                        { style: USAGE_TIER_META_STYLE },
                        t('usage.requests', { count: formatCount(row.requests) }),
                      ),
                      h('span', { style: USAGE_TIER_COST_STYLE }, usdText(t, row.costUsd)),
                    ),
                  ),
                ),
              ),
          h('p', { style: PARAGRAPH_STYLE }, savingsSentence),
          h('p', { style: HINT_STYLE }, t('savings.note')),
          renderWidgetToggle(),
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
                // A preset is the outcome a person picked; a path mount only has a raw
                // tier, so fall back to it before calling the request unpinned.
                const presetLabel = entry.preset === null ? '' : t('preset.' + entry.preset);
                return h(
                  'tr',
                  { key: String(index) },
                  h(
                    'td',
                    { style: TD_STYLE },
                    h(
                      'span',
                      { style: BADGE_STYLE },
                      presetLabel !== '' ? presetLabel : entry.tier === null ? t('preset.none') : entry.tier,
                    ),
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
        /* One profile-level preference, next to the routes it applies to: the preset an
           unchosen Session inherits. Which preset a *particular* Session runs on is the
           composer chip, so the two never compete for the same click. */
        const presetTable = normalizePresetTable(targetsData.tier);
        const presetChoice =
          presetTable !== null && presetTable.presets.length > 0
            ? h(
                'div',
                { key: 'preset-default', style: ROW_STYLE },
                h(
                  'div',
                  { style: ROW_INFO_STYLE },
                  h('span', { style: SUB_LABEL_STYLE }, t('providers.defaultTierCaption')),
                  h('span', { style: HINT_STYLE }, t('providers.defaultTierHint')),
                ),
                h(
                  'div',
                  { style: ROW_CONTROL_STYLE },
                  h(TierSelect, {
                    value: presetTable.default,
                    options: presetTable.presets.map((preset) => ({
                      value: preset,
                      label: t('preset.' + preset),
                    })),
                    ariaLabel: t('providers.defaultTierAria'),
                    disabled: busy !== null,
                    onChange: runDefaultPreset,
                  }),
                ),
              )
            : null;
        /* What each preset actually sends, written once where it can be read calmly. The
           composer menu deliberately carries labels only: a picker that explains itself in
           nine paragraphs is not a picker. */
        const presetGlossary =
          presetTable !== null && presetTable.presets.length > 0
            ? h(
                'div',
                { key: 'preset-glossary', style: PRESET_GRID_STYLE },
                h(
                  'span',
                  { style: Object.assign({}, SUB_LABEL_STYLE, { gridColumn: '1 / -1' }) },
                  t('providers.presetCaption'),
                ),
                presetTable.presets.map((preset) =>
                  h(
                    'div',
                    { key: preset, style: PRESET_ENTRY_STYLE },
                    h('span', { style: SUB_LABEL_STYLE }, t('preset.' + preset)),
                    h('span', { style: HINT_STYLE }, t('preset.' + preset + '.desc')),
                  ),
                ),
              )
            : null;
        return h(
          'div',
          { key: 'created', style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('div', { style: SUB_LABEL_STYLE }, t('providers.createdCaption')),
          presetChoice,
          presetGlossary,
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
        return [renderCreated()];
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

      /* The sections follow the snapshot, not the connection: a poll that fails mid-reload
         keeps the last snapshot (see the status poll), so the page shows the numbers it has
         under the offline banner instead of blanking for a second. */
      return h(
        'section',
        { 'aria-label': t('card.regionAria'), style: PAGE_STYLE },
        header,
        chrome.intro ? h('p', { style: INTRO_STYLE }, t('page.intro')) : null,
        connection === 'offline' ? renderOffline() : null,
        snapshot !== null ? renderMounts() : null,
        snapshot !== null ? renderSavings() : null,
        snapshot !== null ? renderProviders() : null,
        snapshot !== null ? renderRecent() : null,
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

      /**
       * `/health` on the one control API this page can address. There is nothing to
       * search: it is either on this origin or the Host row is not mounted.
       */
      const probe = async () => {
        try {
          const response = await request(controlUrl('/health'), PROBE_TIMEOUT_MS);
          if (!response.ok) return null;
          const payload = await readJsonSafe(response);
          return isPlainObject(payload) && payload.ok !== false ? CONTROL_BASE : null;
        } catch (error) {
          return null;
        }
      };

      /** `/targets` when the relay is usable for this extension, else null. */
      const readTargets = async (base) => {
        try {
          const prefix = typeof base === 'string' && base !== '' ? base : CONTROL_BASE;
          const response = await request(prefix + controlUrl('/targets'), STATUS_TIMEOUT_MS);
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
            const origin = await probe();
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
        /** Force a fresh probe + `/targets` read; used after a write lands. */
        load() {
          return load();
        },
        publish(origin, data) {
          broadcast({ status: 'ready', origin: origin, data: data });
        },
        probe,
        readTargets,
      };
    }

    /** Hard stop for the chip: a thrown render must leave the composer intact. */
    class ChipBoundary extends React.Component {
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
            console.error('[dsh-openrouter-plus] composer tier chip render failed', error, info);
          }
        } catch (ignored) {
          /* logging must never throw out of an error boundary */
        }
      }

      render() {
        return this.state.failed === true ? null : this.props.children;
      }
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
      const [pending, setPending] = React.useState(null);
      const [error, setError] = React.useState('');
      /* Live-model reconciliation: null when idle, otherwise the phase plus the
         preview the Host computed. The preview is what the user confirms, and it
         comes from the same planner the write runs. */
      const [sync, setSync] = React.useState(null);
      const [note, setNote] = React.useState('');

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
        setPending(null);
        setError('');
        setSync(null);
        setNote('');
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
        /* No tier on the way in: the target is the bare mount and the tier is chosen per
           Session, so attaching never pins one. */
        const body = { route: route, upstream: upstream };
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
          setError('');
        } else {
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
          setError('');
        }
        setPending(null);
      };

      /* ── live model picker ───────────────────────────────────────────────
         The Models page's own "Fetch available models" is answered from the pi-ai
         snapshot for any catalog-backed route, and it answers *before* it reads that
         route's baseURL — so it can never show a model OpenRouter published after
         pi-ai was released. This reads the row's own endpoint instead, lists what it
         reports, and adds only the models the user ticks. */
      const modelEndpoint = upstream;

      const readModels = async () => {
        if (pending !== null || (sync !== null && sync.phase !== 'ready')) return;
        const origin = feedState.origin;
        if (origin === null || origin === undefined) {
          setError(t('offline.noReason'));
          return;
        }
        setSync({ phase: 'reading', models: [], selected: [], removed: [], present: 0 });
        setError('');
        setNote('');
        const controller = new AbortController();
        actionControllerRef.current = controller;
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (exception) {
            /* already settled */
          }
        }, MUTATION_TIMEOUT_MS);
        try {
          const url =
            origin + CONTROL_PREFIX + '/models?route=' + encodeURIComponent(route) +
            '&upstream=' + encodeURIComponent(modelEndpoint);
          const response = await fetch(url, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
          const payload = await readJsonSafe(response);
          if (!response.ok) {
            const message = payloadErrorMessage(payload);
            throw new Error(message === '' ? t('error.http', { status: String(response.status) }) : message);
          }
          if (!aliveRef.current) return;
          const models = Array.isArray(payload.models) ? payload.models : [];
          setSync({
            phase: 'ready',
            models: models,
            /* Existing models start ticked (they are in the route); new ones start
               clear, so the list reads as the route's current contents plus what is
               on offer. Unticking an existing model marks it for removal. */
            selected: [],
            removed: [],
            present: models.filter((model) => model.inRoute === true).length,
          });
        } catch (exception) {
          if (!aliveRef.current) return;
          setSync(null);
          setError(mutationMessage(exception));
        } finally {
          clearTimeout(timer);
          if (actionControllerRef.current === controller) actionControllerRef.current = null;
        }
      };

      const toggleModel = (id, inRoute) => {
        setSync((current) => {
          if (current === null || current.phase !== 'ready') return current;
          /* One list, two directions: a model already in the route is unticked into
             `removed`, a model on offer is ticked into `selected`. */
          if (inRoute === true) {
            const removed = current.removed.includes(id)
              ? current.removed.filter((value) => value !== id)
              : [...current.removed, id];
            return { ...current, removed: removed };
          }
          const selected = current.selected.includes(id)
            ? current.selected.filter((value) => value !== id)
            : [...current.selected, id];
          return { ...current, selected: selected };
        });
      };

      const applyModels = async () => {
        if (sync === null || sync.phase !== 'ready') return;
        if (sync.selected.length === 0 && sync.removed.length === 0) {
          setError(t('sync.noneSelected'));
          return;
        }
        const origin = feedState.origin;
        if (origin === null || origin === undefined) {
          setError(t('offline.noReason'));
          return;
        }
        const chosen = [...sync.selected];
        const dropped = [...sync.removed];
        setSync({ ...sync, phase: 'writing' });
        setError('');
        let failure = '';
        const controller = new AbortController();
        actionControllerRef.current = controller;
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (exception) {
            /* already settled */
          }
        }, MUTATION_TIMEOUT_MS);
        try {
          const response = await fetch(origin + CONTROL_PREFIX + '/models/add', {
            method: 'POST',
            mode: 'cors',
            cache: 'no-store',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-oorp-client': CLIENT_HEADER,
            },
            body: JSON.stringify({
              route: route,
              upstream: modelEndpoint,
              models: chosen,
              remove: dropped,
              confirmRemove: dropped.length > 0,
            }),
            signal: controller.signal,
          });
          const payload = await readJsonSafe(response);
          if (!response.ok) {
            const message = payloadErrorMessage(payload);
            throw new Error(message === '' ? t('error.http', { status: String(response.status) }) : message);
          }
          if (!aliveRef.current) return;
          setNote(t('sync.done', {
            added: String(Array.isArray(payload.added) ? payload.added.length : 0),
            removed: String(Array.isArray(payload.removed) ? payload.removed.length : 0),
          }));
        } catch (exception) {
          failure = mutationMessage(exception);
        } finally {
          clearTimeout(timer);
          if (actionControllerRef.current === controller) actionControllerRef.current = null;
        }
        /* The write changed the route, so the card's snapshot is stale either way. */
        const found = await reconcile();
        if (found !== null) feed.publish(found.origin, found.data);
        if (!aliveRef.current) return;
        if (failure === '') {
          setSync(null);
        } else {
          setSync({ ...sync, phase: 'ready', selected: chosen, removed: dropped });
          setError(failure);
        }
      };

      const errorLine = error === '' ? null : h('p', { role: 'alert', style: ALERT_STYLE }, error);

      /* A legacy leg (`<origin>/<tier>/v1`) predates targets: it still reaches the relay,
         but there is no stored endpoint to restore the row to, so it is shown read-only. */
      if (own === null && routed !== null) {
        return h(
          'div',
          { role: 'group', 'aria-label': groupAria, style: STRIP_STYLE },
          h(
            'span',
            { role: 'status', 'aria-live': 'polite', style: STRIP_STATUS_STYLE },
            h('span', null, t('strip.routed')),
            h('span', { style: BADGE_STYLE }, t('preset.' + (presetFromLegacyTier(routed.tier) ?? 'none'))),
          ),
          errorLine,
        );
      }

      /* No stored row and no default: there is nothing this extension can repoint, and an
         attach would need a route the config does not have yet. */
      if (own === null && (source === null || upstream === '')) return null;

      /*
       * One check, and no tier chooser here: ticking it points this provider row at the
       * relay's bare per-endpoint mount, and the tier is then chosen per Session in the
       * composer chip. That is what keeps this feature from minting a provider row per
       * tier — the check exposes the tiers, the chip picks one, nothing else is created.
       */
      const ticked = own !== null;
      const busyLabel = pending === 'attach' ? t('strip.applying') : pending === 'detach' ? t('strip.detaching') : '';

      /*
       * The live-model picker belongs to "OpenRouter Plus is on for this row", not to the
       * pi-ai adapter in general: a row that is not routed through the relay shows the
       * switch and nothing else. That keeps this plugin's surface on the rows the operator
       * actually opted in, instead of decorating every `llm-pi-ai` card with a button that
       * edits a list this plugin is not otherwise part of.
       */
      const canSyncModels = ticked && modelEndpoint !== '';

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
            onChange: () => {
              if (error !== '') setError('');
              /* Switching the row changes which endpoint the list would describe, so a
                 panel from the previous posture is never carried across. */
              if (sync !== null) setSync(null);
              void (ticked ? detach() : attach());
            },
          }),
          h('span', null, t('strip.route')),
        ),
        pending === null
          ? null
          : h('span', { role: 'status', 'aria-live': 'polite', style: STRIP_HINT_STYLE }, busyLabel),
        h('p', { style: STRIP_HINT_STYLE }, ticked ? t('strip.routedHint') : t('strip.tierHint')),
        canSyncModels
          ? h(
              'div',
              { style: STRIP_ACTIONS_STYLE },
              h(ActionButton, {
                label: sync !== null && sync.phase === 'reading' ? t('sync.reading') : t('sync.action'),
                title: t('sync.hint'),
                ariaLabel: t('sync.aria', { name: name }),
                disabled: pending !== null || (sync !== null && sync.phase === 'writing'),
                onClick: () => {
                  void readModels();
                },
              }),
            )
          : null,
        /* The picker: every model the endpoint reports, with the ones this route
           already declares marked so they are not offered twice. It is offered, and it
           writes, only while the row is routed through OpenRouter Plus. */
        canSyncModels && sync !== null && sync.phase !== 'reading' && sync.models.length > 0
          ? h(SyncPicker, {
              t: t,
              name: name,
              models: sync.models,
              selected: sync.selected,
              removed: sync.removed,
              present: sync.present,
              busy: sync.phase === 'writing',
              onToggle: toggleModel,
              onApply: () => {
                void applyModels();
              },
              onCancel: () => setSync(null),
            })
          : null,
        note === ''
          ? null
          : h('p', { role: 'status', 'aria-live': 'polite', style: STRIP_HINT_STYLE }, note),
        errorLine,
      );
    }

    /**
     * The live-model checklist.
     *
     * A route can point at an endpoint that reports hundreds of models, so the list
     * is filtered rather than paginated, and the ids already declared stay visible
     * and unticked (they are marked "added") so the user can see both what they have
     * and what is on offer without the two lists diverging.
     */
    function SyncPicker(props) {
      const t = props.t;
      const [filter, setFilter] = React.useState('');
      const needle = filter.trim().toLowerCase();
      const visible = needle === ''
        ? props.models
        : props.models.filter((model) => String(model.id).toLowerCase().includes(needle)
            || String(model.name || '').toLowerCase().includes(needle));
      const selectedCount = props.selected.length;
      const shown = visible.slice(0, PICKER_LIMIT);

      return h(
        'div',
        {
          role: 'group',
          'aria-label': t('sync.panelAria', { name: props.name }),
          'aria-busy': props.busy ? 'true' : undefined,
          style: STRIP_PICKER_STYLE,
        },
        h('p', { style: { margin: 0, color: COLORS.primary, font: FONTS.tiny } }, t('sync.legend', {
          count: String(props.models.length),
          present: String(props.present),
        })),
        h('input', {
          type: 'search',
          value: filter,
          placeholder: t('sync.filter'),
          'aria-label': t('sync.filter'),
          disabled: props.busy,
          onChange: (event) => setFilter(event.target.value),
          style: PICKER_FILTER_STYLE,
        }),
        h(
          'div',
          { style: PICKER_LIST_STYLE },
          visible.length === 0
            ? h('p', { style: STRIP_HINT_STYLE }, t('sync.noMatch'))
            : visible.length > shown.length
              ? h('p', { style: STRIP_HINT_STYLE }, t('sync.truncated', {
                  shown: String(shown.length),
                  total: String(visible.length),
                }))
              : null,
          shown.map((model) => {
            const id = String(model.id);
            const inRoute = model.inRoute === true;
            const removing = inRoute && props.removed.includes(id);
            const ticking = !inRoute && props.selected.includes(id);
            return h(
              'label',
              { key: id, style: removing ? PICKER_ROW_REMOVING_STYLE : inRoute ? PICKER_ROW_ADDED_STYLE : PICKER_ROW_STYLE },
              h('input', {
                type: 'checkbox',
                /* Ticked means "in the route after Apply": present and not dropped,
                   or chosen from the catalogue. Unticking an existing model removes it,
                   so this is one list with two directions rather than an add-only list. */
                checked: inRoute ? !removing : ticking,
                disabled: props.busy,
                style: { margin: 0, flex: '0 0 auto' },
                onChange: () => props.onToggle(id, inRoute),
              }),
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, id),
              removing
                ? h('span', { style: PICKER_REMOVE_BADGE_STYLE }, t('sync.willRemove'))
                : inRoute
                  ? h('span', { style: PICKER_BADGE_STYLE }, t('sync.already'))
                  : null,
            );
          }),
        ),
        h(
          'div',
          { style: STRIP_ACTIONS_STYLE },
          h(ActionButton, {
            label: props.busy ? t('sync.writing') : t('sync.apply'),
            title: t('sync.selected', {
              added: String(selectedCount),
              removed: String(props.removed.length),
            }),
            disabled: props.busy || (selectedCount === 0 && props.removed.length === 0),
            onClick: props.onApply,
          }),
          h('span', { style: STRIP_STATUS_STYLE }, t('sync.selected', {
            added: String(selectedCount),
            removed: String(props.removed.length),
          })),
          h(ActionButton, {
            label: t('sync.cancel'),
            disabled: props.busy,
            onClick: props.onCancel,
          }),
        ),
      );
    }

    /** One row inside the chip's menu: a tier preset, or a precision floor. */
    function ChipOption(props) {
      const [hovered, setHovered] = React.useState(false);
      const selected = props.selected === true;
      const disabled = props.disabled === true;
      /* A precision row names the wire levels it admits on a second line; a preset row is
         one line and must render exactly as it did before the facet existed. */
      const hint = stringValue(props.hint).trim();
      const stacked = hint !== '';
      const attrs = {
        type: 'button',
        role: 'option',
        'aria-selected': selected,
        disabled: disabled,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onClick: disabled ? undefined : props.onClick,
        style: chipOptionStyle({
          hovered: hovered,
          selected: selected,
          disabled: disabled,
          wrapped: stacked,
        }),
      };
      if (props.kind === 'precision') attrs['data-precision'] = props.value;
      else attrs['data-preset'] = props.value;
      return h(
        'button',
        attrs,
        stacked
          ? h(
              'span',
              { style: CHIP_OPTION_STACK_STYLE },
              h('span', null, props.label),
              h('span', { style: CHIP_OPTION_HINT_STYLE }, hint),
            )
          : h('span', null, props.label),
        selected
          ? h(
              'span',
              { 'aria-hidden': 'true', style: { flex: '0 0 auto', color: COLORS.secondary } },
              '\u2713',
            )
          : null,
      );
    }

    /**
     * One cell of the root pane: the label of what it sets on the left, the value the
     * Session currently runs on in the tertiary tone on the right, and a chevron saying it
     * opens a list. It is the whole navigation of the two-level menu — pressing it drills
     * in, Escape comes back out.
     */
    function ChipCell(props) {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          ref: props.cellRef,
          'aria-label': props.ariaLabel,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onClick: props.onClick,
          style: chipCellStyle({ hovered: hovered, focused: focused }),
        },
        h('span', { style: CHIP_CELL_LABEL_STYLE }, props.label),
        h('span', { style: CHIP_CELL_VALUE_STYLE }, props.value),
        h('span', { 'aria-hidden': 'true', style: CHIP_CELL_CHEVRON_STYLE }, '\u25b8'),
      );
    }

    /**
     * The composer's routing chip: one trigger, one two-level menu.
     *
     * It changes the *Session*, not the provider row: the relay applies the preset to the
     * request body on the way out, so switching is a runtime choice like `reasoningEffort`
     * and never mints a provider route per preset. The preset is an outcome; the precision
     * floor is a constraint on which endpoints that outcome may land on, so both are set
     * from one popover, shaped like the composer's model picker: the root pane is a pair of
     * cells ("Tier — Cheapest ›", "Precision — ≥8-bit ›") and a cell drills into its own
     * list. Escape and Shift+Tab step back out to the root before closing. There is still
     * exactly one control in the composer.
     *
     * Unlike the model picker, a pick returns to the root pane and leaves the popover open,
     * so both facets can be set in one visit; it closes on an outside press, Escape from the
     * root pane, or the trigger itself.
     *
     * This chip talks to the Host's `/tier` and `/precision` APIs and nothing else; it
     * writes no provider configuration, never touches the settings draft, and renders
     * nothing unless the Session runs on a row mounted from one of our targets.
     *
     * A blank Session has no durable `modelSelection` yet (the projection stays
     * `{lastUsed: null, next: null}` until its first message), so keying the chip off the
     * projection alone left it invisible exactly where choosing a tier first matters. The
     * shared `ModelDirectory` both composer entries render from is the fallback: its
     * `current` already holds the resolved default (provider, model, effort) and its
     * `pending` the in-flight choice.
     */
    function TierChip(props) {
      const t = props.t;
      const feed = props.feed;
      const sessionId = props.sessionId;
      const resolveDirectory = props.resolveDirectory;
      const useProjection = props.useProjection;

      /* The shared directory lazily fails loud for an unknown Session; a chip must never be
         the thing that takes the composer down, so an unresolvable Session reads as "no
         directory" and the chip falls back to the durable projection alone. */
      const directory = (() => {
        if (typeof resolveDirectory !== 'function' || sessionId === undefined || sessionId === null) return null;
        try {
          const found = resolveDirectory(sessionId);
          return found === undefined ? null : found;
        } catch (error) {
          return null;
        }
      })();
      const directoryStore =
        directory !== null && directory.store !== null && directory.store !== undefined
          && typeof directory.store.getSnapshot === 'function'
          ? directory.store
          : null;

      const [directoryState, setDirectoryState] = React.useState(() =>
        directoryStore === null ? null : directoryStore.getSnapshot(),
      );

      React.useEffect(() => {
        if (directoryStore === null) return undefined;
        setDirectoryState(directoryStore.getSnapshot());
        return directoryStore.subscribe(() => setDirectoryState(directoryStore.getSnapshot()));
      }, [directoryStore]);

      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      const selection = firstSelection([
        isPlainObject(projection) ? projection.next : null,
        isPlainObject(directoryState) ? directoryState.pending : null,
        isPlainObject(projection) ? projection.lastUsed : null,
        isPlainObject(directoryState) ? directoryState.current : null,
      ]);
      const providerKey = selection === null ? '' : selection.provider;
      const modelKey = selection === null ? '' : selection.model;

      const [feedState, setFeedState] = React.useState(() => feed.snapshot());
      const [open, setOpen] = React.useState(false);
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      /* Which pane the menu shows. It always opens on the root cells — never straight into
         a list — and a cell drills into `tier` or `precision`; Escape/Shift+Tab come back. */
      const [pane, setPane] = React.useState(CHIP_PANE_ROOT);
      const [pendingTier, setPendingTier] = React.useState(null);
      const [pendingPrecision, setPendingPrecision] = React.useState(null);
      const [error, setError] = React.useState('');
      const [anchor, setAnchor] = React.useState(null);
      /* What the Host reports for this Session: `{ preset, chosen, default }`. `chosen` is
         empty until the Session picks a preset, and then it follows the profile default. */
      const [tierState, setTierState] = React.useState(null);
      /* `{ floor, includeUnknown, allow, inherited }`, or null before (or instead of) an
         answer. Null is not an error state: the chip then badges `any`, which hides the
         second half, so a Host from before this feature looks exactly like the old chip. */
      const [precisionState, setPrecisionState] = React.useState(null);

      const chipRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const tierCellRef = React.useRef(null);
      const precisionCellRef = React.useRef(null);
      /* Where the next render should put the keyboard: the cell that opened the drilled
         pane, or the list of the pane just entered. The model picker works the same way. */
      const pendingFocusRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      const lifetimeRef = React.useRef(null);
      const actionRef = React.useRef(null);

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
          if (actionRef.current !== null) {
            try {
              actionRef.current.abort();
            } catch (error) {
              /* already settled */
            }
            actionRef.current = null;
          }
        };
      }, []);

      React.useEffect(() => {
        return feed.subscribe(() => setFeedState(feed.snapshot()));
      }, [feed]);

      /* A different provider is a different route: drop the open menu, the pending
         effort and the failure, and re-measure on the next open. */
      React.useEffect(() => {
        setOpen(false);
        setPane(CHIP_PANE_ROOT);
        setPendingTier(null);
        setPendingPrecision(null);
        setError('');
        setAnchor(null);
      }, [providerKey]);

      /*
       * Read this Session's preset from the Host. It is Session state, not config, so it
       * is fetched rather than derived from the provider row; a Session that never chose
       * one answers `chosen: null` and follows the profile default. Re-read when the relay
       * address changes, since a rebind means the Host plugin may have restarted.
       */
      React.useEffect(() => {
        const origin = feedState.origin;
        if (origin === null || typeof sessionId !== 'string' || sessionId === '') {
          setTierState(null);
          return undefined;
        }
        const controller = new AbortController();
        void (async () => {
          try {
            const response = await fetch(
              origin + CONTROL_PREFIX + '/tier?session=' + encodeURIComponent(sessionId),
              { method: 'GET', mode: 'cors', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal },
            );
            const payload = await readJsonSafe(response);
            if (!response.ok) return;
            const next = normalizePresetState(payload);
            if (next !== null && aliveRef.current) setTierState(next);
          } catch (error) {
            /* A chip must never be the thing that breaks the composer: no answer simply
               leaves the badge on its "no tier" fallback. */
          }
        })();
        return () => {
          try {
            controller.abort();
          } catch (error) {
            /* already aborted */
          }
        };
      }, [feedState.origin, sessionId]);

      /*
       * Read this Session's precision floor beside its preset, in a request of its own. The
       * two are independent on purpose: a failed floor fetch leaves the preset badge (and
       * the whole chip) exactly as released, and a failed preset fetch does not hide the
       * floor. `null` here is the `any` fallback, never a rendering error.
       */
      React.useEffect(() => {
        const origin = feedState.origin;
        if (origin === null || typeof sessionId !== 'string' || sessionId === '') {
          setPrecisionState(null);
          return undefined;
        }
        const controller = new AbortController();
        void (async () => {
          try {
            const response = await fetch(
              origin + CONTROL_PREFIX + '/precision?session=' + encodeURIComponent(sessionId),
              { method: 'GET', mode: 'cors', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal },
            );
            const payload = await readJsonSafe(response);
            if (!response.ok) return;
            const next = normalizePrecisionState(payload);
            if (next !== null && aliveRef.current) setPrecisionState(next);
          } catch (error) {
            /* No answer leaves the badge on `any`: the chip still draws and still switches. */
          }
        })();
        return () => {
          try {
            controller.abort();
          } catch (error) {
            /* already aborted */
          }
        };
      }, [feedState.origin, sessionId]);

      /* Anchor the popover above the trigger, in viewport coordinates: the composer bar
         clips vertical overflow, so an absolutely positioned menu would be cut off. */
      React.useEffect(() => {
        if (!open) return undefined;
        const node = chipRef.current;
        if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
          const rect = node.getBoundingClientRect();
          const height = typeof window === 'undefined' ? 0 : Number(window.innerHeight) || 0;
          setAnchor({
            left: Math.max(8, Math.round(rect.left)),
            bottom: Math.max(8, Math.round(height - rect.top + 6)),
          });
        }
        return undefined;
      }, [open]);

      /* Close on an outside press or Escape, like the composer's own model menu. */
      React.useEffect(() => {
        if (!open) return undefined;
        if (typeof document === 'undefined') return undefined;
        const onPress = (event) => {
          if (chipRef.current !== null && chipRef.current.contains(event.target)) return;
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            setError('');
          }
        };
        document.addEventListener('mousedown', onPress);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onPress);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      /* Focus follows the pane, like the model picker: a drill puts the keyboard on the
         ticked row (or the first one), and coming back hands it to the cell that opened the
         pane. The ref is consumed on the next render, once the new pane is in the DOM. */
      React.useEffect(() => {
        if (!open) return undefined;
        const intent = pendingFocusRef.current;
        pendingFocusRef.current = null;
        if (intent === null) return undefined;
        if (intent !== 'row') {
          const cell = intent === 'precision' ? precisionCellRef.current : tierCellRef.current;
          if (cell !== null && cell !== undefined && typeof cell.focus === 'function') {
            try {
              cell.focus({ preventScroll: true });
            } catch (error) {
              /* an engine that only takes the argument-less form */
            }
          }
          return undefined;
        }
        const menu = menuRef.current;
        if (menu === null || menu === undefined || typeof menu.querySelector !== 'function') return undefined;
        const ticked = menu.querySelector('[role="option"][aria-selected="true"]:not([disabled])');
        const first = menu.querySelector('[role="option"]:not([disabled])');
        const node = ticked !== null ? ticked : first;
        if (node !== null && typeof node.focus === 'function') {
          try {
            node.focus({ preventScroll: true });
          } catch (error) {
            /* an engine that only takes the argument-less form */
          }
        }
        return undefined;
      }, [open, pane]);

      /* What this Session currently runs on. Nothing renders unless the feed is loaded,
         the Session has a selection, that selection's provider row exists, and the row is
         mounted from one of our targets (see `normalizeTargets`). */
      const data = feedState.data;
      if (data === null || providerKey === '' || modelKey === '') return null;

      const source = providerSourceOf(data, providerKey);
      if (source === null) return null;

      /* A plain upstream link (or a legacy `<origin>/<tier>/v1` leg) mounts nothing of
         ours, so the relay would ignore a tier for it: no chip. */
      if (stringValue(source.targetId).trim() === '') return null;

      const name = stringValue(source.displayName).trim() || providerKey;
      /* One mutation at a time, whichever facet started it: both write the same Session. */
      const busy = pendingTier !== null || pendingPrecision !== null;
      /* `chosen` is the preset this Session picked, empty while it follows the profile
         default; `preset` is what its next request will actually send. */
      const activePreset = tierState === null ? 'none' : tierState.preset;
      const chosenPreset = tierState === null || tierState.chosen === null ? '' : tierState.chosen;
      const profileDefault = tierState === null ? 'none' : tierState.default;
      /* The floor the chip badges. A pending pick reads optimistically (`pendingPrecision`),
         so the badge and the ticked row move on the press; the read-back then replaces it,
         or reverts to the confirmed floor when the POST fails. */
      const precisionChoice = precisionState === null ? DEFAULT_PRECISION_CHOICE : precisionState;
      const shownFloor = pendingPrecision === null ? precisionChoice.floor : pendingPrecision;
      const shownUnknown = pendingPrecision === null
        ? precisionChoice.includeUnknown
        : precisionIncludeUnknownDefault(pendingPrecision);
      /* Labels only. What each preset actually sends is explained once on the settings
         page; repeating it here would make every open menu a wall of text. */
      const presetLabel = (id) => t('preset.' + id);
      /* `<preset label>` + `<precision short label>`, or the preset label alone while the floor is
         `any` — which is what keeps a chip nobody has configured pixel-identical to the one this
         plugin already shipped. The two halves stay apart so the floor can be painted in the
         caption tone, the way the model seat paints its effort. */
      const badgeParts = pendingTier === null
        ? chipBadgeParts(t, presetLabel(activePreset), { floor: shownFloor })
        : { label: t('tier.switching'), precision: '' };
      const badge = badgeParts.precision === ''
        ? badgeParts.label
        : badgeParts.label + ' ' + badgeParts.precision;
      const tierText = badge;
      /* The root cells always exist; the rows only matter once a cell has been pressed. */
      const cells = chipRootCells(t, {
        presetLabel: presetLabel,
        activePreset: activePreset,
        switchingPreset: pendingTier !== null,
        floor: shownFloor,
      });
      const rows = pane === CHIP_PANE_ROOT
        ? []
        : chipFacetRows(t, pane, {
            presetLabel: presetLabel,
            profileDefault: profileDefault,
            chosenPreset: chosenPreset,
            precisionFloor: shownFloor,
          });

      /* One POST, no provider write: the Host records the choice for this Session and the
         relay applies it to the request body on the way out. Both facets share this
         transport, so a timeout or a cut response is handled in exactly one place. */
      const postControl = async (path, body) => {
        const origin = feedState.origin;
        if (origin === null) throw new Error(t('offline.noReason'));
        const controller = new AbortController();
        actionRef.current = controller;
        const timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (error) {
            /* already settled */
          }
        }, MUTATION_TIMEOUT_MS);
        try {
          const response = await fetch(origin + CONTROL_PREFIX + path, {
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
            throw new Error(
              controlErrorMessage(payload, t('error.http', { status: String(response.status) })),
            );
          }
          return payload;
        } finally {
          clearTimeout(timer);
          if (actionRef.current === controller) actionRef.current = null;
        }
      };

      const postTier = async (preset) => {
        const payload = await postControl('/tier', {
          session: sessionId,
          preset: preset === '' ? null : preset,
        });
        const next = normalizePresetState(payload);
        if (next === null) throw new Error(t('strip.stalled'));
        return next;
      };

      /* The body names both halves of the floor; the wire list is materialised by the relay
         on read, so the client never sends `allow` and never derives it itself. */
      const postPrecision = async (floor) => {
        const payload = await postControl('/precision', precisionPostBody(sessionId, floor));
        const next = normalizePrecisionState(payload);
        if (next === null) throw new Error(t('strip.stalled'));
        return next;
      };

      const switchTier = async (preset) => {
        if (busy) return;
        if (preset === chosenPreset) {
          setError('');
          return;
        }
        setPendingTier(preset);
        setError('');

        let next = null;
        let failure = '';
        try {
          next = await postTier(preset);
        } catch (exception) {
          failure = unknownOutcomeMessage(t, exception);
        }

        if (!aliveRef.current) return;
        setPendingTier(null);
        if (next === null) {
          setError(t('tier.error', { message: failure === '' ? t('offline.noReason') : failure }));
          return;
        }
        setTierState(next);
        /* The popover stays open: the root cells are one press away, and a pick that closed
           it made "Cheapest · ≥8-bit" a two-visit round trip. */
      };

      const switchPrecision = async (floor) => {
        if (busy) return;
        const target = precisionFloorOf(floor);
        if (target === precisionChoice.floor) {
          setError('');
          return;
        }
        setPendingPrecision(target);
        setError('');

        let next = null;
        let failure = '';
        try {
          next = await postPrecision(target);
        } catch (exception) {
          failure = unknownOutcomeMessage(t, exception);
        }

        if (!aliveRef.current) return;
        setPendingPrecision(null);
        if (next === null) {
          setError(
            t('precision.error', { message: failure === '' ? t('offline.noReason') : failure }),
          );
          return;
        }
        setPrecisionState(next);
      };

      /* The focusable items of the pane that is showing: the two root cells, or the rows. */
      const paneItems = () => {
        const menu = menuRef.current;
        if (menu === null || menu === undefined || typeof menu.querySelectorAll !== 'function') return [];
        const selector = pane === CHIP_PANE_ROOT
          ? '[role="menuitem"]:not([disabled])'
          : '[role="option"]:not([disabled])';
        return Array.prototype.slice.call(menu.querySelectorAll(selector));
      };

      /* ↑/↓ walk the cells on the root pane and the rows inside a list, as they do in the
         model picker; nothing else here moves focus. */
      const moveFocus = (offset) => {
        const items = paneItems();
        if (items.length === 0) return;
        const focusedIndex = items.indexOf(
          typeof document === 'undefined' ? null : document.activeElement,
        );
        const at = focusedIndex === -1
          ? offset > 0
            ? 0
            : items.length - 1
          : (focusedIndex + offset + items.length) % items.length;
        const node = items[at];
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
      };

      /** Drill into one list: the next render puts the keyboard on its ticked row. */
      const drill = (next) => {
        pendingFocusRef.current = 'row';
        /* A stale failure belongs to the pane it happened in, not to this one. */
        setError('');
        setPane(next);
      };

      /** Leave a drilled pane for the root cells, handing the keyboard back to its cell. */
      const back = () => {
        const from = pane === 'precision' ? 'precision' : 'tier';
        pendingFocusRef.current = from;
        setPane(CHIP_PANE_ROOT);
      };

      const closeMenu = (restoreFocus) => {
        setOpen(false);
        setPane(CHIP_PANE_ROOT);
        pendingFocusRef.current = null;
        setError('');
        if (restoreFocus !== true) return;
        queueMicrotask(() => {
          const node = chipRef.current;
          if (node !== null && node !== undefined && typeof node.focus === 'function') {
            try {
              node.focus({ preventScroll: true });
            } catch (error) {
              /* an engine that only takes the argument-less form */
            }
          }
        });
      };

      /* Escape and Shift+Tab leave a drilled pane first and only close from the root, which
         is the ladder the model picker uses. The handler sits on the chip wrapper so it sees
         keys from the trigger and from the popover alike. */
      const onChipKeyDown = (event) => {
        if (!open) return;
        if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey === true)) {
          event.preventDefault();
          event.stopPropagation();
          if (chipPaneAfterKey(pane, event.key, event.shiftKey === true) === null) closeMenu(true);
          else back();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
      };

      /* A pick always returns to the root cells, and the popover stays open: that is the
         one deliberate difference from the model picker, which closes on selection. */
      const chooseRow = (row) => {
        const from = pane;
        if (pane === 'precision') void switchPrecision(row.value);
        else void switchTier(row.value);
        pendingFocusRef.current = from === 'precision' ? 'precision' : 'tier';
        setPane(CHIP_PANE_ROOT);
        setError('');
      };

      const openMenu = () => {
        if (busy) return;
        if (open) {
          closeMenu(false);
          return;
        }
        setError('');
        pendingFocusRef.current = null;
        setPane(CHIP_PANE_ROOT);
        setOpen(true);
      };

      const menuStyle = Object.assign(
        {
          position: 'fixed',
          zIndex: 1100,
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          minWidth: 'min(220px, 100vw - 24px)',
          maxHeight: 'min(320px, 100vh - 96px)',
          overflowY: 'auto',
          padding: '4px',
          border: '1px solid ' + COLORS.border,
          borderRadius: 'var(--dsw-radius-md, 8px)',
          background: COLORS.layerTwo,
          boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18))',
        },
        anchor === null
          ? { left: '8px', bottom: '96px' }
          : { left: String(anchor.left) + 'px', bottom: String(anchor.bottom) + 'px' },
      );

      const errorLine =
        error === '' ? null : h('p', { role: 'alert', style: Object.assign({}, ALERT_STYLE, { margin: '4px 4px 0' }) }, error);

      const activeRows = rows.map((row) =>
        h(ChipOption, {
          key: row.key,
          value: row.value,
          label: row.label,
          hint: row.hint,
          kind: pane === 'precision' ? 'precision' : 'preset',
          selected: row.selected,
          disabled: busy,
          onClick: () => {
            chooseRow(row);
          },
        }),
      );

      /* The root pane: exactly two cells, saying what the Session runs on and opening the
         list behind each. The values are the same ones the trigger badges. */
      const rootPane = h(
        'div',
        { role: 'menu', 'aria-label': t('chip.menuAria'), style: CHIP_PANE_STYLE },
        h(ChipCell, {
          cellRef: tierCellRef,
          label: cells[0].label,
          value: cells[0].value,
          ariaLabel: cells[0].ariaLabel,
          onClick: () => {
            drill('tier');
          },
        }),
        h(ChipCell, {
          cellRef: precisionCellRef,
          label: cells[1].label,
          value: cells[1].value,
          ariaLabel: cells[1].ariaLabel,
          onClick: () => {
            drill('precision');
          },
        }),
      );

      /* The drilled pane: the listbox the pressed cell names, with the hint that belongs to
         it. Selecting a row comes back here, to the root cells. */
      const drilledPane = h(
        'div',
        { style: CHIP_PANE_STYLE },
        h(
          'div',
          {
            role: 'listbox',
            'aria-label': pane === 'precision' ? t('precision.listAria', { name: name }) : t('strip.tierAria', { name: name }),
            style: CHIP_LIST_STYLE,
          },
          activeRows,
        ),
        pane === 'precision'
          ? shownUnknown
            ? h('p', { style: CHIP_HINT_STYLE }, t('precision.unknownAdmitted'))
            : null
          : h('p', { style: CHIP_HINT_STYLE }, t('preset.hint')),
      );

      /* Errors sit below whichever pane is showing, so a failed pick is still readable after
         it has returned to the root cells. */
      const popover = open
        ? h(
            'div',
            {
              ref: menuRef,
              style: menuStyle,
              'aria-busy': busy ? 'true' : undefined,
            },
            pane === CHIP_PANE_ROOT ? rootPane : drilledPane,
            errorLine,
          )
        : null;

      return h(
        'div',
        {
          style: { position: 'relative', display: 'inline-flex', minWidth: 0 },
          onKeyDown: onChipKeyDown,
        },
        h(
          'button',
          {
            type: 'button',
            ref: chipRef,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-busy': busy ? 'true' : undefined,
            'aria-label': t('tier.aria', { name: name, tier: tierText }),
            title: t('strip.tierAria', { name: name }),
            disabled: busy,
            onMouseDown: (event) => event.preventDefault(),
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
            onClick: openMenu,
            style: chipStyle({ open: open, hovered: hovered, focused: focused, disabled: busy }),
          },
          h('span', { style: CHIP_TEXT_STYLE }, badgeParts.label),
          badgeParts.precision === ''
            ? null
            : h('span', { style: CHIP_PRECISION_STYLE }, badgeParts.precision),
          h('span', { 'aria-hidden': 'true', style: CHIP_CARET_STYLE }, open ? '\u25b4' : '\u25be'),
        ),
        popover,
      );
    }

    /* ----------------------------------------- sidebar spend card and its dialog */

    /**
     * Hard stop for the card: a thrown render must leave the sidebar's foot intact. Unlike
     * the page boundary it renders nothing *and* logs nothing — the sidebar is always on
     * screen, and a footer card is not the place to announce that it failed.
     */
    class UsageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      render() {
        return this.state.failed === true ? null : this.props.children;
      }
    }

    /**
     * The sidebar foot card: today's spend and the models that produced it.
     *
     * It owns one chained-setTimeout poll of `/status` (never `setInterval`, so a slow relay
     * cannot stack probes) in the same request shape the settings page uses. Nothing renders
     * until three Host facts line up — the flag is on, the relay owns a socket, and the
     * payload carries a cost — so a Host from before this feature draws no card at all
     * rather than a confident `$0.00`.
     */
    function UsageCard(props) {
      const t = props.t;
      /* The shell computes `wide` as `!collapsed` for the sidebar (frozen through its
         150 ms collapse animation), so `wide === false` is exactly the 56 px rail — where a
         money row cannot live and footer actions are shrunk and centred instead. A shell
         that predates the prop passes nothing, which is treated as wide. */
      const wide = props.wide !== false;

      const [usage, setUsage] = React.useState(null);
      const [detailsOpen, setDetailsOpen] = React.useState(false);
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        let pollTimer = null;
        let inflight = null;

        const schedule = (delayMs) => {
          if (cancelled) return;
          if (pollTimer !== null) clearTimeout(pollTimer);
          pollTimer = setTimeout(() => {
            pollTimer = null;
            void tick();
          }, delayMs);
        };

        const load = async () => {
          const controller = new AbortController();
          inflight = controller;
          const timer = setTimeout(() => {
            try {
              controller.abort();
            } catch (error) {
              /* already settled */
            }
          }, STATUS_TIMEOUT_MS);
          try {
            /* No origin is prepended: the control API is mounted on this document's own
               origin (`CONTROL_BASE` is empty), exactly as the settings page calls it. */
            const response = await fetch(controlUrl('/status'), {
              method: 'GET',
              mode: 'cors',
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: controller.signal,
            });
            if (!response.ok) return null;
            let payload = null;
            try {
              payload = await response.json();
            } catch (error) {
              payload = null;
            }
            return normalizeUsageStatus(payload);
          } finally {
            clearTimeout(timer);
            if (inflight === controller) inflight = null;
          }
        };

        async function tick() {
          if (cancelled) return;
          /* A background tab relays nothing, so it also asks nothing; the chain stays alive
             and the first tick after the tab is visible again is at most one interval away. */
          const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
          if (!hidden) {
            let next = null;
            try {
              next = await load();
            } catch (error) {
              /* A refusal, a timeout or a reloading Host means "not now": the card draws
                 nothing and the next tick asks again. Nothing is logged — see the gate. */
              next = null;
            }
            if (cancelled) return;
            setUsage(next);
          }
          schedule(USAGE_POLL_INTERVAL_MS);
        }

        schedule(0);

        return () => {
          cancelled = true;
          if (pollTimer !== null) clearTimeout(pollTimer);
          pollTimer = null;
          if (inflight !== null) {
            try {
              inflight.abort();
            } catch (error) {
              /* already settled */
            }
            inflight = null;
          }
        };
      }, []);

      /* A relay that stops answering has nothing to show: close the dialog rather than hold
         a frozen snapshot of a service that is gone. Only a *transition* counts — a card that
         remounts with an empty poll (the shell reopening its popover) must not close a dialog
         the reader is looking at. */
      const hadUsage = React.useRef(false);
      React.useEffect(() => {
        if (usage !== null) {
          hadUsage.current = true;
          return;
        }
        setDetailsOpen(false);
        if (hadUsage.current) usageDialogMount.close();
        hadUsage.current = false;
      }, [usage]);

      const closeDetails = React.useCallback(() => setDetailsOpen(false), []);

      if (!wide || usage === null) return null;

      const todayText = usdText(t, usage.todayUsd);

      return h(
        'div',
        { style: USAGE_CARD_STYLE },
        h(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-label': t('usage.openAria', { today: todayText }),
            /* One press, one dialog: the models, the requests and the per-preset split are
               tabs inside the dialog, not a disclosure folded out of the sidebar. */
            onClick: () => {
              /* The card may live inside a shell popover that unmounts on this very press.
                 Opening a root of our own is what keeps the dialog on screen; only a host
                 without react-dom falls back to rendering it in here. */
              if (!usageDialogMount.open(usage, t)) setDetailsOpen(true);
            },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
            style: usageHeaderStyle({ hovered: hovered, focused: focused }),
          },
          h('span', { 'aria-hidden': 'true', style: USAGE_CHEVRON_STYLE }, '\u25b8'),
          h('span', { style: USAGE_TITLE_STYLE }, t('usage.title')),
          h('span', { style: USAGE_AMOUNT_STYLE, title: t('usage.today') }, todayText),
        ),
        detailsOpen ? h(UsageDialog, { t: t, usage: usage, onClose: closeDetails }) : null,
      );
    }

    /**
     * What the card cannot fit: the totals, the per-preset split, and one row per recent
     * relayed request with the raw OpenRouter fields behind a disclosure.
     *
     * It holds no data of its own — the card's poll keeps running while it is open, so the
     * numbers stay live — and its only lifecycle work is the initial focus and Escape.
     */
    function UsageDialog(props) {
      const t = props.t;
      const usage = props.usage;
      const onClose = props.onClose;
      /* One drawer at a time: fifty rows each with a five-field cost block open at once
         would bury the table this dialog exists to show. */
      const [openRow, setOpenRow] = React.useState(-1);
      /* Three views, one dialog. Each tab is one screenful, so money is read as money and
         logs as logs instead of one scroll that mixes the two. */
      const [tab, setTab] = React.useState('models');
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);

      /* A dialog opens where the reader looks: the panel itself, whose own label names it.
         Focus is not trapped past this, so Tab reaches the close button first. */
      React.useEffect(() => {
        const node = panelRef.current;
        if (node === null || node === undefined || typeof node.focus !== 'function') return;
        try {
          node.focus({ preventScroll: true });
        } catch (error) {
          /* an engine that only takes the argument-less form */
        }
      }, []);

      const summary = h(
        'div',
        { key: 'summary', style: STATS_ROW_STYLE },
        h(
          'div',
          { style: STAT_STYLE },
          h('span', { style: STAT_LABEL_STYLE }, t('usage.today')),
          h('span', { style: { font: FONTS.metric } }, usdText(t, usage.todayUsd)),
        ),
        h(
          'div',
          { style: STAT_STYLE },
          h('span', { style: STAT_LABEL_STYLE }, t('usage.total')),
          h('span', { style: { font: FONTS.metric } }, usdText(t, usage.totalUsd)),
        ),
      );

      /* Models: what each model that answered today cost, and the token mix behind it. */
      /* Models as a table: one row per model, and the columns carry the numbers the card
         used to jam into a sentence. The footer totals the day, so nobody has to add a
         column up by eye. */
      const modelRows = usage.byModel.map((row) =>
        h(
          'tr',
          { key: row.model },
          h(
            'td',
            { style: TD_STYLE },
            h(
              'div',
              {
                style: Object.assign({}, codeStyle, {
                  maxWidth: '240px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }),
                title: row.model,
              },
              row.model,
            ),
          ),
          h('td', { style: TD_RIGHT_STYLE }, compactTokens(row.promptTokens)),
          h('td', { style: TD_RIGHT_STYLE }, compactTokens(row.cacheReadTokens)),
          h('td', { style: TD_RIGHT_STYLE }, compactTokens(row.cacheWriteTokens)),
          h('td', { style: TD_RIGHT_STYLE }, compactTokens(row.completionTokens)),
          h('td', { style: TD_RIGHT_STYLE }, formatCount(row.requests)),
          h('td', { style: TD_RIGHT_STYLE }, usdText(t, row.costUsd)),
        ),
      );
      const modelTotals = usage.byModel.reduce(
        (total, row) => ({
          promptTokens: total.promptTokens + row.promptTokens,
          cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
          cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
          completionTokens: total.completionTokens + row.completionTokens,
          requests: total.requests + row.requests,
        }),
        { promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, completionTokens: 0, requests: 0 },
      );
      const modelsSection =
        usage.byModel.length === 0
          ? h('p', { style: USAGE_EMPTY_STYLE }, t('usage.empty'))
          : h(
              'div',
              { style: USAGE_TABLE_SCROLL_STYLE },
              h(
                'table',
                { style: USAGE_TABLE_STYLE },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.model')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.input')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.cacheRead')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.cacheWrite')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.output')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.requests')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.cost')),
                  ),
                ),
                h('tbody', null, modelRows),
                h(
                  'tfoot',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', { style: Object.assign({}, TD_STYLE, { color: COLORS.secondary }) }, t('usage.totalsRow')),
                    h('td', { style: TD_RIGHT_STYLE }, compactTokens(modelTotals.promptTokens)),
                    h('td', { style: TD_RIGHT_STYLE }, compactTokens(modelTotals.cacheReadTokens)),
                    h('td', { style: TD_RIGHT_STYLE }, compactTokens(modelTotals.cacheWriteTokens)),
                    h('td', { style: TD_RIGHT_STYLE }, compactTokens(modelTotals.completionTokens)),
                    h('td', { style: TD_RIGHT_STYLE }, formatCount(modelTotals.requests)),
                    h('td', { style: TD_RIGHT_STYLE }, usdText(t, usage.todayUsd)),
                  ),
                ),
              ),
            );

      /* Presets: which routing outcome the money actually went through. */
      const presetsSection =
        usage.byTier.length === 0
          ? h('p', { style: USAGE_EMPTY_STYLE }, t('usage.byTierEmpty'))
          : h(
              'ul',
              { style: USAGE_TIER_LIST_STYLE },
              usage.byTier.map((row) =>
                h(
                  'li',
                  { key: row.tier, style: USAGE_TIER_ROW_STYLE },
                  h('span', { style: USAGE_TIER_LABEL_STYLE }, usageTierLabel(t, row.tier)),
                  h('span', { style: USAGE_TIER_META_STYLE }, t('usage.requests', { count: formatCount(row.requests) })),
                  h('span', { style: USAGE_TIER_COST_STYLE }, usdText(t, row.costUsd)),
                ),
              ),
            );

      /* Sessions: the same money cut by the conversation that spent it. The relay learns the
         session from the request envelope, so this cut needs no join with the Host. */
      const sessionsSection =
        usage.bySession.length === 0
          ? h('p', { style: USAGE_EMPTY_STYLE }, t('usage.sessionsEmpty'))
          : h(
              'div',
              { style: USAGE_TABLE_SCROLL_STYLE },
              h(
                'table',
                { style: USAGE_TABLE_STYLE },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.sessionName')),
                    h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.session')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.requests')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('recent.column.tokens')),
                    h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.cost')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  usage.bySession.map((row) =>
                    h(
                      'tr',
                      { key: row.session },
                      h(
                        'td',
                        { style: TD_STYLE },
                        h(
                          'div',
                          {
                            style: {
                              maxWidth: '220px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                            title: row.title === '' ? undefined : row.title,
                          },
                          row.title === '' ? t('common.notAvailable') : row.title,
                        ),
                      ),
                      h(
                        'td',
                        { style: TD_STYLE },
                        h(
                          'div',
                          {
                            style: Object.assign({}, codeStyle, {
                              maxWidth: '240px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }),
                            title: row.session,
                          },
                          row.session,
                        ),
                      ),
                      h('td', { style: TD_RIGHT_STYLE }, formatCount(row.requests)),
                      h('td', { style: TD_RIGHT_STYLE }, compactTokens(row.promptTokens + row.completionTokens)),
                      h('td', { style: TD_RIGHT_STYLE }, usdText(t, row.costUsd)),
                    ),
                  ),
                ),
              ),
            );

      const rawField = (label, value) =>
        h(
          'div',
          { key: label, style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('span', { style: USAGE_RAW_LABEL_STYLE }, label),
          h('span', { style: USAGE_RAW_VALUE_STYLE }, value),
        );

      const rows = [];
      if (usage.recent.length === 0) {
        rows.push(
          h(
            'tr',
            { key: 'empty' },
            h(
              'td',
              { colSpan: 11, style: Object.assign({}, TD_STYLE, { color: COLORS.secondary }) },
              t('recent.empty'),
            ),
          ),
        );
      } else {
        usage.recent.forEach((entry, index) => {
          const time = clockTime(entry.at);
          const timeText = time === '' ? t('common.notAvailable') : time;
          /* The preset is the outcome a person picked; the wire tier only exists for the
             presets that send one, so it is the fallback label. */
          const preset = presetFromLegacyTier(entry.preset);
          const presetLabel = preset === null ? usageTierLabel(t, entry.tier) : t('preset.' + preset);
          /* A served tier that differs from the sent one is the "the provider shed this
             request" case: OpenRouter answered on a different endpoint than asked for. Raw
             names on both sides, because that difference is the information. */
          const sentTier = entry.tier === null ? '' : entry.tier;
          const shed = entry.servedTier !== '' && entry.servedTier.toLowerCase() !== sentTier.toLowerCase();
          const promptTokens = entry.promptTokens;
          const completionTokens = entry.completionTokens;
          const tokenTotal =
            promptTokens === null && completionTokens === null
              ? null
              : (promptTokens === null ? 0 : promptTokens) + (completionTokens === null ? 0 : completionTokens);
          const open = openRow === index;
          const rawId = 'openrouter-plus-usage-raw-' + String(index);
          const modelText = entry.model === '' ? t('common.notAvailable') : entry.model;
          const sessionFull = entry.sessionId === '' ? '' : entry.sessionId;
          const sessionText = sessionFull === ''
            ? t('common.notAvailable')
            : sessionFull.length > 12
              ? sessionFull.slice(0, 8) + '\u2026'
              : sessionFull;

          rows.push(
            h(
              'tr',
              { key: 'row-' + String(index) },
              h(
                'td',
                { style: Object.assign({}, TD_STYLE, { width: '20px', paddingRight: '2px' }) },
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-expanded': open,
                    'aria-controls': rawId,
                    'aria-label': t('usage.rowDetailAria', { time: timeText }),
                    onClick: () => setOpenRow(open ? -1 : index),
                    style: USAGE_TRIGGER_STYLE,
                  },
                  h('span', { 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8'),
                ),
              ),
              h('td', { style: Object.assign({}, TD_STYLE, { whiteSpace: 'nowrap' }) }, timeText),
              h(
                'td',
                { style: TD_STYLE },
                h(
                  'div',
                  {
                    style: Object.assign({}, codeStyle, {
                      maxWidth: '220px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }),
                    title: modelText,
                  },
                  modelText,
                ),
              ),
              h(
                'td',
                { style: TD_STYLE },
                entry.providerName === ''
                  ? t('common.notAvailable')
                  : h(
                      'div',
                      {
                        style: {
                          maxWidth: '110px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                        title: entry.providerName,
                      },
                      entry.providerName,
                    ),
              ),
              h(
                'td',
                { style: TD_STYLE },
                h('span', { style: BADGE_STYLE }, presetLabel),
                shed
                  ? h(
                      'div',
                      { style: { color: COLORS.secondary, font: FONTS.tiny } },
                      t('usage.servedAs', { tier: entry.servedTier }),
                    )
                  : null,
              ),
              h(
                'td',
                {
                  style: Object.assign({}, TD_STYLE, { whiteSpace: 'nowrap' }),
                  title: sessionFull === '' ? undefined : sessionFull,
                },
                sessionText,
                entry.sessionTitle === ''
                  ? null
                  : h(
                      'div',
                      {
                        style: {
                          color: COLORS.secondary,
                          font: FONTS.tiny,
                          maxWidth: '130px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      entry.sessionTitle,
                    ),
              ),
              h(
                'td',
                {
                  style: Object.assign({}, TD_STYLE, {
                    color: entry.status !== null && entry.status >= 400 ? COLORS.error : COLORS.primary,
                  }),
                },
                entry.status === null ? t('common.notAvailable') : String(entry.status),
              ),
              h(
                'td',
                { style: TD_RIGHT_STYLE },
                entry.ms === null ? t('common.notAvailable') : t('common.ms', { value: formatCount(entry.ms) }),
              ),
              h('td', { style: TD_STYLE }, entry.streaming ? t('recent.stream') : t('common.notAvailable')),
              h('td', { style: TD_RIGHT_STYLE }, usdText(t, entry.costUsd)),
              h(
                'td',
                {
                  style: TD_RIGHT_STYLE,
                  title:
                    tokenTotal === null
                      ? undefined
                      : t('usage.tokensTitle', {
                          input: formatCount(promptTokens),
                          cacheRead: formatCount(entry.cacheReadTokens),
                          cacheWrite: formatCount(entry.cacheWriteTokens),
                          output: formatCount(completionTokens),
                        }),
                },
                tokenTotal === null ? t('usage.notReported') : formatCount(tokenTotal),
              ),
            ),
          );

          if (!open) return;
          rows.push(
            h(
              'tr',
              { key: 'raw-' + String(index) },
              h(
                'td',
                { colSpan: 9, style: { padding: 0, borderBottom: '1px solid ' + COLORS.border } },
                h(
                  'div',
                  { id: rawId, style: USAGE_RAW_STYLE },
                  h('span', { style: USAGE_RAW_HEADING_STYLE }, t('usage.rawFields')),
                  rawField(
                    t('usage.servedModel'),
                    entry.servedModel !== '' ? entry.servedModel : entry.model !== '' ? entry.model : t('usage.notReported'),
                  ),
                  rawField(t('usage.servedTier'), entry.servedTier === '' ? t('usage.notReported') : entry.servedTier),
                  rawField(t('usage.byok'), entry.byok ? t('usage.yes') : t('usage.no')),
                  rawField(t('usage.genId'), entry.genId === '' ? t('usage.notReported') : entry.genId),
                  h(
                    'span',
                    { style: Object.assign({}, USAGE_RAW_HEADING_STYLE, { paddingTop: '6px' }) },
                    t('usage.costDetails'),
                  ),
                  /* Two separate charges: what OpenRouter billed for the relayed call, and
                     what the caller's own provider key paid for the upstream leg. Never
                     summed — with BYOK the second one is the caller's bill, not OpenRouter's. */
                  rawField(t('usage.costTotal'), usdText(t, entry.costUsd)),
                  rawField(t('usage.costUpstream'), usdText(t, entry.upstreamCostUsd)),
                  rawField(t('usage.costPrompt'), usdText(t, entry.promptCostUsd)),
                  rawField(t('usage.costCompletion'), usdText(t, entry.completionCostUsd)),
                  rawField(t('usage.costTool'), usdText(t, entry.toolCostUsd)),
                  entry.byok ? h('p', { style: USAGE_RAW_NOTE_STYLE }, t('usage.byokNote')) : null,
                ),
              ),
            ),
          );
        });
      }

      const recentSection = h(
        'div',
        { key: 'recent', style: USAGE_SECTION_STYLE },
        h(
          'div',
          { style: USAGE_TABLE_SCROLL_STYLE },
          h(
            'table',
            { style: USAGE_TABLE_STYLE },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col', style: TH_STYLE }, h('span', { style: visuallyHidden }, t('usage.rawFields'))),
                h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.time')),
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.model')),
                h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.provider')),
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.tier')),
                h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.session')),
                h('th', { scope: 'col', style: TH_STYLE }, t('recent.column.status')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('recent.column.ms')),
                h('th', { scope: 'col', style: TH_STYLE }, t('usage.column.stream')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('usage.column.cost')),
                h('th', { scope: 'col', style: TH_RIGHT_STYLE }, t('recent.column.tokens')),
              ),
            ),
            h('tbody', null, rows),
          ),
        ),
      );

      /* Tabs, not one long scroll: Models answers "what cost money", Requests answers "which
         call", Presets answers "which routing outcome". The split keeps each panel a reader
         can take in at once. */
      const USAGE_TAB_IDS = ['models', 'requests', 'presets', 'sessions'];
      const tabBar = h(
        'div',
        { role: 'tablist', 'aria-label': t('usage.tabsLabel'), style: USAGE_TAB_BAR_STYLE },
        USAGE_TAB_IDS.map((id) =>
          h(
            'button',
            {
              key: id,
              id: USAGE_TAB_ID_PREFIX + id,
              type: 'button',
              role: 'tab',
              'aria-selected': tab === id,
              'aria-controls': USAGE_TAB_PANEL_ID,
              onClick: () => setTab(id),
              style: usageTabStyle(tab === id),
            },
            t('usage.tab.' + id),
          ),
        ),
      );
      const panels = { models: modelsSection, requests: recentSection, presets: presetsSection, sessions: sessionsSection };
      const panel = h(
        'div',
        {
          role: 'tabpanel',
          id: USAGE_TAB_PANEL_ID,
          'aria-labelledby': USAGE_TAB_ID_PREFIX + tab,
          style: USAGE_TAB_PANEL_STYLE,
        },
        panels[tab],
      );

      return h(
        'div',
        {
          style: USAGE_OVERLAY_STYLE,
          onMouseDown: (event) => {
            /* A press that starts on the backdrop closes it; one that starts inside the
               panel and ends here (a text selection dragged out) must not. */
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('usage.dialogTitle'),
            tabIndex: -1,
            ref: panelRef,
            style: USAGE_DIALOG_STYLE,
          },
          h(
            'div',
            { style: USAGE_DIALOG_HEAD_STYLE },
            h('h3', { style: USAGE_DIALOG_TITLE_STYLE }, t('usage.dialogTitle')),
            h(ActionButton, { label: t('usage.close'), ariaLabel: t('usage.close'), onClick: onClose }),
          ),
          summary,
          tabBar,
          panel,
        ),
      );
    }

    /**
     * The details dialog has to outlive the card that opens it.
     *
     * The card sits in `sidebar.footer.action`, and a shell is free to host that slot inside
     * a popover that unmounts on the next outside press — including the press on our own
     * Details button. A dialog rendered in the card's subtree would die with the card, so it
     * is mounted into a root of its own on `document.body` and owned by this module instead:
     * opening it is a call, not a card state change, and only closing it removes the dialog.
     * That also takes it out of any `[data-...-part~=foot-area]` subtree a skin styles.
     *
     * @returns {{ available: boolean, open: (usage: object, t: Function) => boolean,
     *   close: () => void, destroy: () => void }}
     */
    function createUsageDialogMount() {
      let host = null;
      let root = null;
      const available = ReactDOM !== null && typeof document !== 'undefined';

      function close() {
        /* Keep the root: reopening is common, and unmounting would throw away the container
           the shell already painted over. `render(null)` takes the dialog down. */
        if (root !== null) root.render(null);
      }

      function open(usage, t) {
        if (!available || usage === null || usage === undefined) return false;
        if (host === null) {
          host = document.createElement('div');
          host.setAttribute('data-openrouter-plus', 'usage-dialog');
          document.body.appendChild(host);
          root = ReactDOM.createRoot(host);
        }
        root.render(h(UsageDialog, { t: t, usage: usage, onClose: close }));
        return true;
      }

      function destroy() {
        try {
          if (root !== null) root.unmount();
        } catch (error) {
          /* a root already torn down by the shell */
        }
        root = null;
        if (host !== null && host.parentNode !== null) host.parentNode.removeChild(host);
        host = null;
      }

      return { available, open, close, destroy };
    }

    const usageDialogMount = createUsageDialogMount();

    /* -------------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale'],
      /* Pure payload readers, exported only so `test/client.test.mjs` can pin the shape
         tolerance the settings page and the chip depend on. Nothing here touches React or
         the DOM, and the loader ignores extra fields on a module object. */
      __test: {
        normalizePresetTable,
        normalizePresetState,
        normalizeMounts,
        pinnedMounts,
        presetFromLegacyTier,
        /* The sidebar card's gates are the one place a Host version skew decides whether
           anything renders at all, so they are pinnable like the mount readers above. */
        normalizeUsageStatus,
        normalizeUsageRecent,
        pageChrome,
        controlUrl,
        controlBase: CONTROL_BASE,
        /* The chip's two facets are mostly view state, so the pieces a test can hold still
           are the payload readers, the badge text and the row lists they feed. */
        normalizePrecisionState,
        normalizePrecisionChoice,
        precisionFloorOf,
        precisionPostBody,
        precisionShortLabel,
        chipBadgeLabel,
        chipFacetRows,
        /* The root pane and the pane ladder are the two-level menu's whole behaviour, so
           they are exported as plain data/decisions rather than pinned through a DOM. */
        chipRootCells,
        chipPaneAfterKey,
        chipPaneRoot: CHIP_PANE_ROOT,
        chipPanes: CHIP_PANES,
        precisionFloors: PRECISION_FLOORS,
        precisionWireLevels: PRECISION_WIRE_LEVELS,
        /* Both dictionaries, so a new key cannot land in one language only: the zh one
           must be real Chinese, and a key that is not registered renders its own name. */
        dictionaries: { en: en, zh: zh },
      },
      apply(ctx) {
        /* Dictionary registration is owned by the plugin context and disposed with it. */
        ctx.effect(
          () => ctx.locale.register(NS, { en: en, zh: zh }),
          'dsh-openrouter-plus: locale dictionaries',
        );

        /* The details dialog is mounted on `document.body`, outside this plugin's tree: a
           reload has to take its root down or the overlay outlives the bundle that drew it. */
        ctx.effect(
          () => () => usageDialogMount.destroy(),
          'dsh-openrouter-plus: usage dialog root',
        );

        const t = ctx.locale.bind(NS);

        /*
        * One body, two seats. `seat` decides the chrome (see `pageChrome`), not the content:
        * the Settings page draws its own title and intro, the Plugins bundle page is framed by
        * the package's title, version and description.
        */
        function pageFor(seat) {
          return function OpenRouterPlusPage() {
            return h(PageBoundary, { t: t }, h(PageBody, { t: t, seat: seat }));
          };
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
            pageFor('settings'),
          ),
        );

        /*
        * The same page on the bundle's own Plugins page (Plugins → Installed → OpenRouter
        * Plus, in the sidebar's plugin manager, not Settings → Built-in plugins, which only
        * lists component status). The profile lists this plugin as a bundle, so that card
        * exists whether or not we answer here — without this registration it shows the
        * package's title, rows, version, source and Uninstall, and nothing to configure.
        *
        * The seat is keyed by the BUNDLE's package name, `dsh-openrouter-plus` — not the row
        * id (`openrouter-plus`) the patch declares and not the locale namespace; a wrong key
        * fails silently by rendering nothing. The page draws its own title, icon and crumb,
        * and `view` is always `'page'` here (bundle configuration has no summary form), which
        * is why the seat cannot be told apart from the owner props and travels as our own
        * prop instead.
        *
        * Keep this seat `view: 'page'` and the body self-contained: the host-owned `form`
        * prop (a `ConfigPageForm` over the settings service) is unused here, because this
        * plugin's configuration lives on the relay's control API, not in a settings schema.
        */
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-openrouter-plus' },
            pageFor('plugins'),
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

        /*
         * The sidebar foot, beside Settings: `sidebar.footer.action` is a free `list` seat,
         * so the registration carries an id of ours and no owner key. The card owns its own
         * poll, and draws nothing unless the Host enables the flag, the relay owns a socket,
         * and the payload carries a cost — on an older Host the footer is left untouched.
         */
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'openrouter-plus-usage', order: 0 },
            function OpenRouterPlusUsage(props) {
              return h(UsageBoundary, null, h(UsageCard, Object.assign({}, props, { t: t })));
            },
          ),
        );

        /*
         * The composer's right-hand control list, beside the model selector. `list` seats
         * are keyed by their occupant, so the registration carries an `id` of ours and no
         * owner key. `modelDirectories` belongs to the model-selection client plugin, so
         * the chip is registered inside `ctx.inject`: without that UI the plugin still
         * loads, and the chip simply never appears.
         */
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          const models = scope.modelDirectories;

          function ComposerTierExtension(ownerProps) {
            return h(
              ChipBoundary,
              null,
              h(
                TierChip,
                Object.assign({}, ownerProps, {
                  t: t,
                  feed: targetsFeed,
                  resolveDirectory: (targetSession) => {
                    try {
                      return models.directoryFor(targetSession);
                    } catch (error) {
                      /* An addressed subagent Session (or an unmounted one) has no
                         directory; the chip renders and the click explains itself. */
                      return null;
                    }
                  },
                }),
              ),
            );
          }

          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              { name: 'conversation.input.right', id: 'openrouter-plus-tier' },
              ComposerTierExtension,
            ),
          );
        });
      },
    };
  },
});
