import { z } from "zod";
import { visibleText } from "./visible-text.js";

export const attentionSchema = z.object({
  platform: z.enum(["github", "hacker-news", "huggingface"]),
  id: z.string(), url: z.string(), measuredAt: z.string(),
  previousMeasuredAt: z.string().nullable(), elapsedHours: z.number().nullable(),
  score: z.number(), scoreDelta: z.number().nullable(), scorePerHour: z.number().nullable(),
  secondaryCount: z.number(), secondaryDelta: z.number().nullable(),
});
export type Attention = z.infer<typeof attentionSchema>;

// What a candidate says about itself comes from outside, and is cleaned of invisible characters where it is read (see visible-text.ts).
export const candidateSchema = z.object({
  title: z.string().transform(visibleText),
  summary: z.string().transform(visibleText),
  url: z.string().transform(visibleText),
  publishedAt: z.string().nullable(),
  source: z.string().transform(visibleText),
  category: z.string().transform(visibleText),
  dateKind: z.enum(["published", "first-seen", "changed"]).optional(),
  firstSeenAt: z.string().optional(), observedAt: z.string().optional(), submittedAt: z.string().optional(),
  attention: z.array(attentionSchema).optional(),
});

export type Candidate = z.infer<typeof candidateSchema>;
