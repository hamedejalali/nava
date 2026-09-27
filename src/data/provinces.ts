/**
 * The 31 provinces (استان) of Iran, with their capital/center city.
 *
 * `id` doubles as the canonical Persian province name and the value stored
 * on the user's profile / used for server-side validation — province names
 * in Persian are stable, unique, and don't need a separate slug system.
 */
export interface Province {
  id: string;
  nameFa: string;
  centerCityId: string;
  /** Numeric province id used by the sajaddp/list-of-cities-in-Iran
   *  cities.json dataset — reverse-engineered and cross-validated directly
   *  against the uploaded file itself (each id below was confirmed via at
   *  least one, usually several, unambiguous city names known to belong
   *  to that province — see conversation for the verification queries).
   *  Used to join against the city dataset without fuzzy string matching. */
  sourceId: number;
}

export const PROVINCES: Province[] = [
  { id: "آذربایجان شرقی", nameFa: "آذربایجان شرقی", centerCityId: "تبریز", sourceId: 103 },
  { id: "آذربایجان غربی", nameFa: "آذربایجان غربی", centerCityId: "ارومیه", sourceId: 104 },
  { id: "اردبیل", nameFa: "اردبیل", centerCityId: "اردبیل", sourceId: 124 },
  { id: "اصفهان", nameFa: "اصفهان", centerCityId: "اصفهان", sourceId: 110 },
  { id: "البرز", nameFa: "البرز", centerCityId: "کرج", sourceId: 130 },
  { id: "ایلام", nameFa: "ایلام", centerCityId: "ایلام", sourceId: 116 },
  { id: "بوشهر", nameFa: "بوشهر", centerCityId: "بوشهر", sourceId: 118 },
  { id: "تهران", nameFa: "تهران", centerCityId: "تهران", sourceId: 123 },
  { id: "چهارمحال و بختیاری", nameFa: "چهارمحال و بختیاری", centerCityId: "شهرکرد", sourceId: 114 },
  { id: "خراسان جنوبی", nameFa: "خراسان جنوبی", centerCityId: "بیرجند", sourceId: 129 },
  { id: "خراسان رضوی", nameFa: "خراسان رضوی", centerCityId: "مشهد", sourceId: 109 },
  { id: "خراسان شمالی", nameFa: "خراسان شمالی", centerCityId: "بجنورد", sourceId: 128 },
  { id: "خوزستان", nameFa: "خوزستان", centerCityId: "اهواز", sourceId: 106 },
  { id: "زنجان", nameFa: "زنجان", centerCityId: "زنجان", sourceId: 119 },
  { id: "سمنان", nameFa: "سمنان", centerCityId: "سمنان", sourceId: 120 },
  { id: "سیستان و بلوچستان", nameFa: "سیستان و بلوچستان", centerCityId: "زاهدان", sourceId: 111 },
  { id: "فارس", nameFa: "فارس", centerCityId: "شیراز", sourceId: 107 },
  { id: "قزوین", nameFa: "قزوین", centerCityId: "قزوین", sourceId: 126 },
  { id: "قم", nameFa: "قم", centerCityId: "قم", sourceId: 125 },
  { id: "کردستان", nameFa: "کردستان", centerCityId: "سنندج", sourceId: 112 },
  { id: "کرمان", nameFa: "کرمان", centerCityId: "کرمان", sourceId: 108 },
  { id: "کرمانشاه", nameFa: "کرمانشاه", centerCityId: "کرمانشاه", sourceId: 105 },
  { id: "کهگیلویه و بویراحمد", nameFa: "کهگیلویه و بویراحمد", centerCityId: "یاسوج", sourceId: 117 },
  { id: "گلستان", nameFa: "گلستان", centerCityId: "گرگان", sourceId: 127 },
  { id: "گیلان", nameFa: "گیلان", centerCityId: "رشت", sourceId: 101 },
  { id: "لرستان", nameFa: "لرستان", centerCityId: "خرم‌آباد", sourceId: 115 },
  { id: "مازندران", nameFa: "مازندران", centerCityId: "ساری", sourceId: 102 },
  { id: "مرکزی", nameFa: "مرکزی", centerCityId: "اراک", sourceId: 100 },
  { id: "هرمزگان", nameFa: "هرمزگان", centerCityId: "بندر عباس", sourceId: 122 },
  { id: "همدان", nameFa: "همدان", centerCityId: "همدان", sourceId: 113 },
  { id: "یزد", nameFa: "یزد", centerCityId: "یزد", sourceId: 121 },
];

export function isValidProvince(id: string): boolean {
  return PROVINCES.some((p) => p.id === id);
}
