import { z } from "zod";

const httpsUrl=z.string().url().refine(value=>new URL(value).protocol==="https:", "La URL debe usar HTTPS.");
export const brandKitSchema=z.object({
  businessName:z.string().trim().min(1).max(120),
  description:z.string().max(2000).optional(),
  audience:z.string().max(500).optional(),
  tone:z.string().max(500).optional(),
  logoUrl:httpsUrl.optional(),
  colors:z.object({
    primary:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    secondary:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accent:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
  }).optional(),
  websiteUrl:httpsUrl.optional(),
  instagramHandle:z.string().regex(/^@?[A-Za-z0-9._]{1,30}$/).optional(),
  rules:z.array(z.string().max(300)).max(20).optional(),
  preferredStyle:z.enum(["editorial","producto","promocion"]).optional()
}).strict();

export const productSchema=z.object({
  id:z.string().trim().min(1).max(128),
  name:z.string().trim().min(1).max(200),
  description:z.string().max(2000).optional(),
  price:z.number().nonnegative().finite().optional(),
  currency:z.string().regex(/^[A-Z]{3}$/).optional(),
  imageUrls:z.array(httpsUrl).max(10),
  productUrl:httpsUrl.optional(),
  availability:z.enum(["available","unavailable","unknown"]).default("unknown"),
  category:z.string().max(120).optional()
}).strict();
export const productsBatchSchema=z.object({products:z.array(productSchema).max(100)}).strict();
export type BrandKitInput=z.infer<typeof brandKitSchema>;
export type ProductInput=z.infer<typeof productSchema>;
