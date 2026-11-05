import { PLUGIN_CAPABILITIES } from './plugins';
export function kitMarketMessage(code: string): string {
  const messages: Record<string, string> = {
    market_not_configured: '这个市场尚未独立配置。',
    kit_product_configuration_changed: '已配置的市场或 Heart 绑定发生变化，请先处理本机配置，不能自动接管原安装。',
    market_context_changed: '账号或本机配置已切换，请重新预览。',
    market_preview_expired_or_changed: '安装预览已过期或配置发生变化，请重新预览。',
    unsupported_managed_admission: '当前本机运行时不支持受管调用门禁，请更新配套客户端和 Portal。',
    portal_host_requires_existing_full_access_policy: '该 MCP Host 需要已有的 FullAccess 策略；Kit 确认不会更改当前安全设置。',
    desktop_plugin_reference_cancelled: '已取消引用现有插件。',
    desktop_app_selection_cancelled: '已取消选择已有 App。',
    release_blocked: '该发布已被阻止，不能安装或重新启用。',
    release_unlisted: '该发布已下架，新安装和下载不可用。',
    release_blocked_revocation_pending: '该发布已被阻止；本机停止尚未确认，需完成恢复或核对。',
    installation_recovery_required: '这项安装仍有未完成操作，请先恢复或核对。',
  };
  if (messages[code]) return messages[code];
  if (code.endsWith(':external_plugin_content_conflict')) return '本机原插件与该发布内容不同。请由原所有者处理版本和其他引用后重新预览。';
  if (code.endsWith(':plugin_single_instance_reference_conflict')) return '该单实例插件仍被其他 Kit 固定，不能只更新这一个安装。';
  return code;
}
export function nativeReviewLines(preview: unknown): string[] {
  const detail = (preview as any)?.detail;
  if (!detail || typeof detail !== 'object') return [];
  if (detail.executor === 'os_app') return [`已有 App：${detail.name}（${detail.association_id}）`, '关联已确认；OS 安装和版本未验证。'];
  const lines = [`SDK ${detail.sdk} · 最低要求 ${detail.minimum_sdk || '未另行指定'}`];
  if (Array.isArray(detail.added_capabilities) && detail.added_capabilities.length) for (const capability of detail.added_capabilities) lines.push(`新增能力：${PLUGIN_CAPABILITIES[capability as keyof typeof PLUGIN_CAPABILITIES] || capability}`);
  else lines.push('没有新增插件能力。');
  if (detail.external_reference) lines.push('使用明确选择的现有原插件；保留其原所有权和数据。');
  if (detail.requires_explicit_enable) lines.push('用户曾停用此插件；需要重新确认启用。');
  return lines;
}
export function permissionReviewLines(raw: unknown): string[] {
  const lines: string[] = [];
  if (raw && typeof raw === 'object') for (const permissions of Object.values(raw)) {
    if (!permissions || typeof permissions !== 'object') continue;
    for (const [field, label] of [['read_roots', '读取已配置资源'], ['write_roots', '写入已配置资源'], ['network_hosts', '网络访问']] as const) {
      const values = (permissions as any)[field]; if (Array.isArray(values) && values.length) lines.push(`${label}：${values.join('、')}`);
    }
  }
  return [...new Set(lines)].length ? [...new Set(lines)] : ['没有额外声明的资源或网络权限。'];
}
