// Station names verified against metro.spb.ru, 2026-10-28. Offline search.
export const stations = `Девяткино|Гражданский проспект|Академическая|Политехническая|Площадь Мужества|Лесная|Выборгская|Площадь Ленина|Чернышевская|Площадь Восстания|Владимирская|Пушкинская|Технологический институт|Балтийская|Нарвская|Кировский завод|Автово|Ленинский проспект|Проспект Ветеранов|Парнас|Проспект Просвещения|Озерки|Удельная|Пионерская|Чёрная речка|Петроградская|Горьковская|Невский проспект|Сенная площадь|Фрунзенская|Московские ворота|Электросила|Парк Победы|Московская|Звёздная|Купчино|Беговая|Зенит|Приморская|Василеостровская|Гостиный двор|Маяковская|Площадь Александра Невского|Елизаровская|Ломоносовская|Пролетарская|Обухово|Рыбацкое|Горный институт|Спасская|Достоевская|Лиговский проспект|Новочеркасская|Ладожская|Проспект Большевиков|Улица Дыбенко|Комендантский проспект|Старая Деревня|Крестовский остров|Чкаловская|Спортивная|Адмиралтейская|Садовая|Звенигородская|Обводный канал|Волковская|Бухарестская|Международная|Проспект Славы|Дунайская|Шушары|Путиловская|Юго-Западная`.split("|").sort((a,b)=>a.localeCompare(b,"ru"));
const normalize = x => String(x).toLocaleLowerCase("ru").replaceAll("ё","е");
export const searchStations = query => stations.filter(x=>normalize(x).includes(normalize(query)));
export const crewCount = e => /фрез/i.test(e.name) ? 2 : 1;
export const selectedEquipment = c => c.equipment.filter(e=>c.request.equipment.includes(e.id));
export const selectedITR = c => c.people.filter(p=>p.group === "itr" && c.request.people.includes(p.id));
export function responsible(c) {
  return selectedITR(c).find(p=>p.id===c.request.responsibleId) || (selectedITR(c).length===1 ? selectedITR(c)[0] : null);
}
export function lunch(c, object, {mechanic=false, spare=false, workers=0}={}) {
  workers=Number(workers);
  if(!Number.isSafeInteger(workers) || workers<0 || workers>10000) throw Error("Количество рабочих: целое число от 0 до 10000");
  const rows=selectedEquipment(c).map(e=>({name:e.name,count:crewCount(e)}));
  const itr=selectedITR(c);
  rows.push(...itr.map(p=>({name:p.name+" · ИТР",count:1})));
  if(workers) rows.push({name:"Рабочие",count:workers});
  if(mechanic) rows.push({name:"Слесарь",count:1});
  if(spare) rows.push({name:"Запасной обед",count:1});
  const person=responsible(c);
  return {rows, total:rows.reduce((sum,r)=>sum+r.count,0),person,
    phone:person?.phone || person?.telephone || "",
    address:object.address || object.location || c.name};
}
export function lunchText(c, object, dateLabel, options) {
  const x=lunch(c,object,options);
  return `${dateLabel}\n${x.address}\nФреза\nСмена: ${c.request.shift === "night" ? "ночная" : "дневная"}\nКоличество обедов: ${x.total}\nОтветственный: ${x.person?.name || "не выбран"}\nТелефон: ${x.phone || "добавьте в справочник ИТР"}`;
}
