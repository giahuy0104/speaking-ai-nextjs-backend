// Prints the length of the translation instructions sent to DeepInfra (to estimate tokens).
import { buildEnglishInstruction, buildTargetLanguageInstruction } from "../src/lib/ai/prompts";
console.log("en", buildEnglishInstruction("home", 6).length);
for (const lang of ["zh", "ja", "ko", "fr"] as const) console.log(lang, buildTargetLanguageInstruction(lang, "home", 6).length);
