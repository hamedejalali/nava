/** Gift catalog (Telegram-gifts style). Prices are in Relic; the owner can override them from the admin panel. */
export interface GiftDef {
  id: string;
  emoji: string;
  name: string; // Persian
  price: number; // default price in Relic
  c1: string; // card gradient
  c2: string;
  pattern: string; // tiny symbols tiled behind the gift (like Telegram's gift backgrounds)
}

export const GIFTS: GiftDef[] = [
  { id: "heart", emoji: "❤️", name: "قلب", price: 1, c1: "#ff6b8b", c2: "#c2185b", pattern: "💗" },
  { id: "rose", emoji: "🌹", name: "گل رز", price: 2, c1: "#ff5f6d", c2: "#8e1b3a", pattern: "🌸" },
  { id: "bear", emoji: "🧸", name: "خرس", price: 3, c1: "#f6b36b", c2: "#a45a2a", pattern: "⭐" },
  { id: "box", emoji: "🎁", name: "کادو", price: 5, c1: "#7f8cff", c2: "#4a2fbd", pattern: "✨" },
  { id: "cake", emoji: "🍰", name: "کیک", price: 5, c1: "#ffa6c9", c2: "#c04884", pattern: "🍓" },
  { id: "rocket", emoji: "🚀", name: "موشک", price: 10, c1: "#4facfe", c2: "#1b4fb5", pattern: "⭐" },
  { id: "cup", emoji: "🏆", name: "جام", price: 15, c1: "#ffd86b", c2: "#c28a00", pattern: "✨" },
  { id: "ring", emoji: "💍", name: "حلقه", price: 25, c1: "#9ee6ff", c2: "#2c6fb7", pattern: "💎" },
  { id: "diamond", emoji: "💎", name: "الماس", price: 50, c1: "#6be3ff", c2: "#0a5cd6", pattern: "💠" },
  { id: "crown", emoji: "👑", name: "تاج", price: 100, c1: "#ffcf4a", c2: "#b46a00", pattern: "👑" },
];

export function giftById(id: unknown): GiftDef | undefined {
  return typeof id === "string" ? GIFTS.find((g) => g.id === id) : undefined;
}
