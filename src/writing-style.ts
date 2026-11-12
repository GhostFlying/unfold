import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AppError, type WritingStyle } from "./types.js";

const directory = new URL("./skills/chineseplz/", import.meta.url);
const origin = JSON.parse(
  readFileSync(new URL("ORIGIN.json", directory), "utf8"),
);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function verifiedText(file: string) {
  const text = readFileSync(new URL(file, directory), "utf8");
  if (digest(text) !== origin.files[file])
    throw new AppError(
      "writing_skill_changed",
      "Bundled writing skill differs from its pinned source",
      500,
    );
  return text;
}

const instructions = `Unfold 的文字编辑要求（适用于本次生成）：
本次使用 chineseplz 的 write-plain-chinese skill 组织中文过程说明和最终结果。依据实际源码与已有证据完成调查，在同一次生成中复核表达。读者是想看懂这次修改的工程师：直接说明谁在什么条件下改了什么、为什么改、有什么影响。
编辑范围包括摘要、HTML/SVG 中的说明文字、改动分组与修改点、公开进度和私有回答。必须保留事实、判断强度、否定、条件、范围和未验证状态；术语需要时保留并解释实际所指，不把推断写成事实。
最终交付须符合当前任务的 JSON schema。直接交付讲解或回答，仅在任务要求时说明修改理由。HTML/JS/CSS/SVG 的程序结构和行为、原代码引文、数字、命令、路径、接口名、版本和引用 ID 保持准确。
下附 skill 规定文字表达，任务的源码证据、执行审批、隐私和隔离要求继续适用。使用现有受限工具完成调查；额外执行、网络和发布需要遵守宿主权限检查。规则和两份示例已完整提供，应按语境采用；示例中的数字、结论与验证状态仅用于说明表达方法。无需读取上游网站或个人 skill 目录。

<chineseplz_skill>
${verifiedText("SKILL.md")}
</chineseplz_skill>

<chineseplz_original_examples>
${verifiedText("references/original-examples.md")}
</chineseplz_original_examples>

<chineseplz_terminology_examples>
${verifiedText("references/terminology-examples.md")}
</chineseplz_terminology_examples>`;

export const writingStyle: WritingStyle = Object.freeze({
  name: origin.name,
  source: origin.repository,
  revision: origin.commit,
  sha256: digest(instructions),
});

// Inject on every turn: resumed native threads retain their original developer
// instructions, so installing only a thread/start instruction misses them.
export function withWritingStyle(task: string) {
  return `${instructions}\n\n<unfold_generation_task>\n${task}\n</unfold_generation_task>`;
}
