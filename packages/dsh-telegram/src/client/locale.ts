/**
 * Strings for the settings page.
 *
 * The harness ships bilingual, so a page that only speaks English reads as
 * half-finished next to the built-in sections. Both locales are kept in one
 * file so a new string cannot be added to one and forgotten in the other.
 *
 * The dictionary keys are `en` and `zh` — the shell's own tags, not BCP 47.
 * A dictionary filed under `en-US` matches nothing, and `ctx.locale.bind`
 * answers an unresolved key with the key itself, so the page renders the word
 * "heading" where its heading should be. `test/client-bundle.test.ts` pins the
 * tags for that reason.
 */

/** Every string the page renders, keyed by the locale the shell selects. */
export const locales = {
  en: {
    nav: 'Telegram',
    heading: 'Telegram',
    subheading: 'Talk to the agent from Telegram, with real formatting and answerable questions.',

    loading: 'Reading configuration…',
    unavailable:
      'This browser cannot reach the settings document, so nothing here can be changed. Settings are loopback-only — open the harness on the machine running it.',
    readonly: 'The settings document is read-only in this deployment.',

    connectionTitle: 'Connection',
    enabled: 'Connected',
    enabledHint: 'Turn off to disconnect the bot without removing the plugin.',
    tokenTitle: 'Bot token',
    tokenChecking: 'Checking…',
    tokenCheckFailed: 'Could not check the stored token: {reason}',
    tokenRetry: 'Check again',
    tokenReadOnly: 'This credential is read-only in this deployment.',
    tokenConfigured: 'A token is stored.',
    tokenMissing: 'No token yet. Create a bot with @BotFather and paste its token here.',
    tokenFromEnvironment: 'Supplied by the environment, so it cannot be changed here.',
    tokenPlaceholder: 'Paste a bot token',
    tokenSave: 'Save token',
    tokenClear: 'Remove token',
    tokenSaved: 'Token saved. Reconnecting.',
    tokenRef: 'Credential reference',
    tokenRefHint: 'Where the token is stored. Change it only to keep several bots apart.',
    baseUrl: 'Bot API address',
    baseUrlHint: 'Change only when routing through a proxy.',

    accessTitle: 'Access',
    accessWarning:
      'Anyone allowed here can make the agent run commands on this machine. Leave the list empty to hand the bot to one person with the claim code printed on the console.',
    allowFrom: 'Allowed Telegram user ids',
    allowFromHint: 'Comma separated. Empty enables the one-time claim flow. Send /whoami to find an id.',
    allowFromInvalid: 'Enter numeric user ids separated by commas.',

    mediaTitle: 'Attachments',
    mediaEnabled: 'Read images and text files',
    mediaHint: 'Off replies that attachments are not accepted.',
    visionModel: 'Model that reads images',
    visionModelHint:
      'Chosen from the models added in Settings → Models. It must accept images — no DeepSeek model does. An image is read in a session of its own, and only what it says joins your conversation, which therefore keeps its own model and tools.',
    visionModelNone: 'Send the image to the conversation itself',
    visionModelLoading: 'Reading the configured models…',
    visionModelUnreadable: 'Could not read the configured models. Add one in Settings → Models.',
    visionModelUnavailable: 'No longer configured',

    screenTitle: 'Screen',
    screenshotEnabled: 'Allow /screenshot',
    screenshotHint:
      "Sends a picture of this machine's screen to the chat. Off by default — a screen holds whatever happens to be on it. On macOS the harness also needs Screen Recording permission.",

    repliesTitle: 'Replies',
    streamingEnabled: 'Stream the answer as it is written',
    streamingHint: 'Off sends each reply once, when it is finished.',
    throttle: 'Minimum gap between edits (ms)',
    throttleHint: 'Telegram rate-limits rapid edits to one chat. Below about a second invites that.',

    advancedTitle: 'Advanced',
    cwd: 'Working directory for new conversations',
    cwdHint: 'Empty uses the directory the harness was started in.',
    longPoll: 'Long-poll seconds',
    timeout: 'Request timeout (ms)',

    overridden: 'changed',
    reset: 'Reset',
    saveFailed: 'That change was not saved: {reason}',
  },

  zh: {
    nav: 'Telegram',
    heading: 'Telegram',
    subheading: '在 Telegram 里与 Agent 对话，保留完整格式，并可直接回答提问。',

    loading: '正在读取配置…',
    unavailable: '此浏览器无法访问设置文档，因此这里无法修改。设置仅限本机访问，请在运行 harness 的机器上打开。',
    readonly: '此部署的设置文档为只读。',

    connectionTitle: '连接',
    enabled: '已连接',
    enabledHint: '关闭后断开机器人连接，但不卸载插件。',
    tokenTitle: '机器人 Token',
    tokenChecking: '正在检查…',
    tokenCheckFailed: '无法检查已保存的 Token：{reason}',
    tokenRetry: '重新检查',
    tokenReadOnly: '此部署中该凭据为只读。',
    tokenConfigured: '已保存 Token。',
    tokenMissing: '尚未配置 Token。请用 @BotFather 创建机器人并把 Token 粘贴到这里。',
    tokenFromEnvironment: '由环境变量提供，无法在此修改。',
    tokenPlaceholder: '粘贴机器人 Token',
    tokenSave: '保存 Token',
    tokenClear: '删除 Token',
    tokenSaved: 'Token 已保存，正在重新连接。',
    tokenRef: '凭据引用名',
    tokenRefHint: 'Token 的存放位置。仅在需要区分多个机器人时修改。',
    baseUrl: 'Bot API 地址',
    baseUrlHint: '仅在通过代理时才需要修改。',

    accessTitle: '访问权限',
    accessWarning:
      '这里允许的人都能让 Agent 在本机执行命令。留空则通过控制台打印的认领码把机器人交给一个人。',
    allowFrom: '允许的 Telegram 用户 ID',
    allowFromHint: '用逗号分隔。留空启用一次性认领流程。发送 /whoami 可查看自己的 ID。',
    allowFromInvalid: '请输入以逗号分隔的数字用户 ID。',

    mediaTitle: '附件',
    mediaEnabled: '读取图片和文本文件',
    mediaHint: '关闭后，收到附件时回复不接受。',
    visionModel: '负责读取图片的模型',
    visionModelHint:
      '从 设置 → Models 中已添加的模型里选择。该模型必须支持图片——DeepSeek 的模型都不支持。图片会在一个独立的临时会话中被读取，只有读出的文字进入你的对话，因此对话本身仍保留原有模型与工具。',
    visionModelNone: '把图片直接发给对话本身',
    visionModelLoading: '正在读取已配置的模型…',
    visionModelUnreadable: '无法读取已配置的模型。请先在 设置 → Models 中添加。',
    visionModelUnavailable: '已不再配置',

    screenTitle: '屏幕',
    screenshotEnabled: '允许 /screenshot',
    screenshotHint:
      '把本机屏幕的截图发到聊天里。默认关闭——屏幕上有什么就会拍到什么。在 macOS 上，harness 还需要「屏幕录制」权限。',

    repliesTitle: '回复',
    streamingEnabled: '边生成边显示回答',
    streamingHint: '关闭后，每条回复在写完后一次性发送。',
    throttle: '两次编辑的最小间隔（毫秒）',
    throttleHint: 'Telegram 对同一会话的频繁编辑有限流。低于约一秒容易触发。',

    advancedTitle: '高级',
    cwd: '新会话的工作目录',
    cwdHint: '留空则使用启动 harness 的目录。',
    longPoll: '长轮询秒数',
    timeout: '请求超时（毫秒）',

    overridden: '已修改',
    reset: '恢复默认',
    saveFailed: '未能保存该修改：{reason}',
  },
} as const

/** Keys the page may ask for; a typo becomes a type error rather than a blank. */
export type LocaleKey = keyof (typeof locales)['en']

/** Translate one key, used where a real locale binding is not available. */
export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string
