// Icon-generation skill exposure for the online MCP server.
//
// The skill body is embedded at build time (see scripts/generate-icon-skill.mjs)
// rather than read from disk, so the serverless bundle cannot lose it.
import { ICON_SKILL_MARKDOWN } from './icon-skill.generated.mjs';

export const ICON_SKILL_NAME = 'rainforest-icon-generator';
export const ICON_SKILL_URI = 'rainforest://skills/icon-generator';
export const ICON_SKILL_CATALOG_URI = 'skill://rainforest-navigator/rainforest-icon-generator/SKILL.md';
export const ICON_PROMPT_NAME = 'rainforest_generate_navigation_icon';
export const ICON_SKILL_DESCRIPTION =
  'Generate standardized 64×64 SVG website icons for RainForest Navigator from a website name or URL, then safely apply them to online navigation entries.';

export function iconSkillMarkdown() {
  return ICON_SKILL_MARKDOWN;
}

export async function iconSkillDigest() {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ICON_SKILL_MARKDOWN)),
  );
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function iconSkillEntry() {
  return {
    uri: ICON_SKILL_CATALOG_URI,
    frontmatter: {
      name: ICON_SKILL_NAME,
      description: ICON_SKILL_DESCRIPTION,
    },
    resources: [{ uri: ICON_SKILL_CATALOG_URI, digest: await iconSkillDigest() }],
  };
}

// Write tools that produce icons must present the digest returned by the guide,
// so a stale skill body cannot be used to author an icon.
export async function requireCurrentIconSkill(skillDigest) {
  const expected = await iconSkillDigest();
  if (skillDigest !== expected) {
    throw new Error('Icon skill version is missing or stale. Call online_get_icon_generation_guide and pass its skillDigest unchanged.');
  }
  return expected;
}

export function iconPromptDefinition() {
  return {
    name: ICON_PROMPT_NAME,
    title: 'Generate a RainForest navigation icon',
    description:
      'Generate a standards-compliant website icon and optionally apply it to an online navigation entry.',
    arguments: [
      { name: 'target', description: 'Website URL, domain, or brand name.', required: true },
      { name: 'uuid', description: 'Optional RainForest navigation entry UUID to update.', required: false },
    ],
  };
}

export function iconPromptMessage({ markdown, digest, target, uuid }) {
  const followUp = uuid
    ? `\nNavigation entry UUID: ${uuid}\nAfter generating the SVG, call online_generate_navigation_icon with this skillDigest, then online_get_navigation_entry to verify the iconUrl changed.`
    : '\nIf adding this site, use online_add_navigation_entry_with_icon with this skillDigest.';

  return {
    description: `Generate a RainForest navigation icon for ${target}`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${markdown}\n\nCurrent skill digest: ${digest}\nTarget: ${target}${followUp}`,
        },
      },
    ],
  };
}
