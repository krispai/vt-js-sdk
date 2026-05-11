/**
 * Vocabulary configuration loader
 * Loads vocabulary and dictionary based on VITE_VOCAB_TYPE environment variable
 */

import positiveVocab from "./assets/vt_custom_vocab.json";
import negativeVocab from "./assets/vt_custom_vocab_negative.json";

type VocabType = "positive" | "negative";

interface VocabConfig {
  vocabulary: string[];
  dictionary: Record<string, string>;
}

const vocabConfigs: Record<VocabType, VocabConfig> = {
  positive: positiveVocab,
  negative: negativeVocab,
};

/**
 * Get the current vocabulary type from environment
 */
export function getVocabType(): VocabType {
  const type = import.meta.env.VITE_VOCAB_TYPE as string;
  if (type === "negative") {
    return "negative";
  }
  return "positive";
}

/**
 * Get the vocabulary configuration based on environment setting
 */
export function getVocabConfig(): VocabConfig {
  const type = getVocabType();
  console.log(`[VOCAB] Using ${type} vocabulary configuration`);
  return vocabConfigs[type];
}

export const vocabConfig = getVocabConfig();
