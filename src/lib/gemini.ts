import { getSystemSettingWithEnvFallback } from "@/lib/system-settings";

export async function getGeminiApiKey() {
  return getSystemSettingWithEnvFallback("gemini_api_key", "GEMINI_API_KEY");
}
