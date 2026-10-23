import { describe, expect, test } from "bun:test"
import { detectLanguage, words } from "../../src/autoreview/i18n.ts"

describe("detectLanguage", () => {
  const mac = (language?: string) => () => language

  test("goes by the locale variables, LC_ALL first", () => {
    expect(detectLanguage({ LANG: "zh_CN.UTF-8" }, mac("en-US"))).toBe("zh")
    expect(detectLanguage({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, mac("zh-Hans-CN"))).toBe("en")
    expect(detectLanguage({ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }, mac())).toBe("zh")
  })

  test("falls back to macOS's preferred language when they are unset or only C or POSIX, then to English", () => {
    expect(detectLanguage({ LANG: "C.UTF-8" }, mac("zh-Hans-CN"))).toBe("zh")
    expect(detectLanguage({ LANG: "POSIX", LC_ALL: "" }, mac("en-GB"))).toBe("en")
    expect(detectLanguage({}, mac("zh-Hant-TW"))).toBe("zh")
    expect(detectLanguage({}, mac())).toBe("en")
  })

  test("has the same words in both languages", () => {
    expect(Object.keys(words("zh"))).toEqual(Object.keys(words("en")))
  })
})
