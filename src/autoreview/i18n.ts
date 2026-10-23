import { execFileSync } from "node:child_process"

/**
 * The plugin's own words for the user, in the language of the environment it
 * runs in. What the agent and the review model write follows the chat instead.
 */
export type Language = "en" | "zh"

export interface Words {
  readonly review: string
  readonly autoApproved: string
  /** Why the review left the request to the user, when the model gave no reason of its own. */
  readonly noReason: string
  readonly unreadable: string
  readonly keptLooking: (rounds: number) => string
  readonly timeout: (seconds: number) => string
  readonly failed: (error: string) => string
}

const WORDS: Record<Language, Words> = {
  en: {
    review: "⚠ Auto review: ",
    autoApproved: "Auto-approved",
    noReason: "did not clearly allow it, and gave no reason",
    unreadable: "its answer could not be read",
    keptLooking: (rounds) => `still looking at files after ${rounds} rounds`,
    timeout: (seconds) => `no verdict within ${seconds} seconds`,
    failed: (error) => `the call failed (${error})`,
  },
  zh: {
    review: "⚠ 自动审查：",
    autoApproved: "已自动放行",
    noReason: "没有明确放行，也没写理由",
    unreadable: "回答读不懂",
    keptLooking: (rounds) => `看了 ${rounds} 轮文件仍没结论`,
    timeout: (seconds) => `${seconds} 秒内没给出结论`,
    failed: (error) => `调用出错（${error}）`,
  },
}

export const words = (language: Language): Words => WORDS[language]

/** macOS's first preferred language, such as `zh-Hans-CN`; undefined elsewhere or when it cannot be read. */
function macPreferredLanguage(): string | undefined {
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })
    return out.match(/\(\s*"?([A-Za-z_-]+)/)?.[1]
  } catch {
    return undefined
  }
}

/**
 * The locale variables decide, as for any program, unless they are unset or
 * only C or POSIX, which OpenCode's server and the shells it starts often get;
 * then macOS's preferred language. English otherwise.
 */
export function detectLanguage(env: Record<string, string | undefined> = process.env, preferred: () => string | undefined = macPreferredLanguage): Language {
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) => value && !/^(C|POSIX)([._@]|$)/i.test(value)) ?? preferred()
  return locale?.toLowerCase().startsWith("zh") ? "zh" : "en"
}
