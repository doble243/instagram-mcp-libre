import type { BrandKit, CatalogProduct } from "./store.js";

export type StyleName="editorial"|"producto"|"promocion";
export function stylePresets(brand:BrandKit|null) {
  const color=brand?.colors?.primary??"#171717";
  return [
    {id:"editorial" as const,label:"Editorial",background:"#F7F5F0",foreground:color,accent:brand?.colors?.accent??color,logoUrl:brand?.logoUrl??null},
    {id:"producto" as const,label:"Producto",background:"#FFFFFF",foreground:"#171717",accent:color,logoUrl:brand?.logoUrl??null},
    {id:"promocion" as const,label:"Promoción",background:color,foreground:"#FFFFFF",accent:brand?.colors?.accent??"#F4D28A",logoUrl:brand?.logoUrl??null}
  ];
}

/** Deterministic content suggestion using only catalog facts. */
export function suggestProductContent(product:CatalogProduct,brand:BrandKit|null,format:"feed"|"story",style?:StyleName) {
  if(product.availability==="unavailable") throw new Error("El producto está marcado como no disponible.");
  if(!product.imageUrls.length) throw new Error("El producto necesita al menos una imagen real.");
  const chosen=style??brand?.preferredStyle??"producto";
  const design=stylePresets(brand).find(p=>p.id===chosen)!;
  const price=product.price!==undefined&&product.currency?` · ${product.currency} ${product.price.toLocaleString("es-UY")}`:"";
  const link=product.productUrl??brand?.websiteUrl??null;
  const caption=`${product.name}${price}. Conocé más en ${brand?.businessName??"nuestra tienda"}.${link?` ${link}`:""}`;
  return {
    productId:product.id,format,style:design,
    canvas:format==="story"?{width:1080,height:1920}:{width:1080,height:1350},
    title:product.name,subtitle:product.category??null,price:product.price??null,currency:product.currency??null,
    imageUrl:product.imageUrls[0],logoUrl:brand?.logoUrl??null,link,caption,
    reviewRequired:true,availability:product.availability??"unknown"
  };
}
