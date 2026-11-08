/** npm install --prefix /tmp/cuedeck-demo-tools pptxgenjs@4.0.1; node scripts/demo-pptx/build.cjs */
const path = require('node:path')
const fs = require('node:fs')
let PptxGenJS
try { PptxGenJS = require('pptxgenjs') } catch { PptxGenJS = require('/tmp/cuedeck-demo-tools/node_modules/pptxgenjs') }
const root = path.resolve(__dirname, '../../demos/powerpoint')
const pres = new PptxGenJS()
pres.layout = 'LAYOUT_WIDE'
pres.author = 'CueDeck'
pres.subject = 'Демонстрация и регрессия PPTX'
pres.title = 'CueDeck: одна презентация для проверки'
pres.lang = 'ru-RU'
pres.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'ru-RU' }
pres.defineSlideMaster({ title: 'DEMO', background: { color: '101724' }, objects: [] })
const cases = []
const sections = new Set()
const text = (s, value, x, y, w, h, size=22, color='FFFFFF', extra={}) => s.addText(value, {x,y,w,h,fontSize:size,color,margin:0,isTextBox:true,breakLine:false,...extra})
function slide(id, title, expected, section='Материалы') {
 if (!sections.has(section)) { pres.addSection({title:section}); sections.add(section) }
 const s = pres.addSlide({ masterName:'DEMO', sectionTitle:section })
 text(s, id, .55,.35,2,.3,12,'63DFA0')
 text(s,title,.55,.85,12.1,.8,36,'FFFFFF',{bold:true})
 text(s,expected,.55,6.45,12.1,.65,16,'C2CCDC')
 s.addNotes(`Сценарий ${id}. ${title}. Ожидаемое поведение: ${expected}`)
 cases.push({slide:cases.length+1,id,title,expected})
 return s
}
function card(s, label, x=1, y=2, w=11.3,h=3.8) {s.addShape(pres.ShapeType.roundRect,{x,y,w,h,rectRadius:.15,fill:{color:'1D2A3C'},line:{color:'1D2A3C'}});text(s,label,x+.35,y+.35,w-.7,h-.7,28)}
const gif=(s,name,x=1,y=2,w=6.4,h=3.6)=>s.addImage({path:path.join(root,'media',name+'.gif'),x,y,w,h,objectName:'gif-'+name})
const video=(s,name,x=1,y=2,w=9.6,h=4)=>s.addMedia({type:'video',path:path.join(root,'media',name+'.mp4'),x,y,w,h,objectName:'video-'+name})
let s=slide('START','CueDeck: проверяем на одной презентации','Листаем по порядку. Описание проверки и заметки остаются рядом с примером.','Начало')
card(s,'Анимации · видео · GIF\nПереходы · Overlay · кликер')
s=slide('NOTES','Заметки докладчика и таймер','Заметка видна на суфлёре. Таймер материала задаём через меню карточки.','Начало');card(s,'На экране: материал докладчика\nВ заметках: подсказка оператору')
s.addNotes('Проверить суфлёр, размер текста и сообщения спикеру. Это заметка из PPTX, она не должна попадать в зал.')
s=slide('CUT','Слайд без перехода','В PPTX переход отсутствует. При проверке отключить ручной FADE карточки.','Переходы');card(s,'Смена кадра без растворения')
s=slide('FADE','Переход Fade из PowerPoint','В файле Fade 400 мс. Сравните режимы: из презентации, свой FADE и без переходов.','Переходы');card(s,'Переход берётся из файла PPTX')
s=slide('BUILD','Три появления по клику','Каждый следующий шаг добавляет одну карточку. В CueDeck это отдельные PDF-страницы.','Анимации')
for(let i=0;i<3;i++){s.addShape(pres.ShapeType.roundRect,{x:.7+i*4.2,y:2.3,w:3.9,h:2.8,fill:{color:['225544','314D75','633E64'][i]},line:{color:'101724'},objectName:'build-'+i});text(s,String(i+1),1.05+i*4.2,3,3.2,1,54)}
s=slide('VIDEO-A','Видео A: автоматический запуск','Движение и тон 440 Гц начинаются при входе на слайд.','Видео');video(s,'clip-a')
s=slide('VIDEO-B','Видео B: следующий слайд','Другой цвет и тон 880 Гц. На переходе не должно быть чёрного кадра.','Видео');video(s,'clip-b')
s=slide('VIDEO-A2','Видео A: повторное использование','Тот же файл начинается с начала. Не остаётся последний кадр предыдущего видео.','Видео');video(s,'clip-a')
s=slide('AFTER-VIDEO','Статика после трёх видео','Сразу виден этот слайд. Чёрного кадра и звука предыдущего ролика нет.','Видео');card(s,'Видео → статика\nПроверка возврата к обычному слайду')
s=slide('VIDEO-CLICK','Видео: запуск по команде','Автозапуска нет. В PowerPoint кликнуть видео, в CueDeck нажать воспроизведение.','Видео');video(s,'clip-b')
s=slide('VIDEO-LOOP','Футаж: зацикленный ролик','Ролик повторяется. Во время проверки свернуть оператор и вернуться через несколько циклов.','Видео');video(s,'clip-a')
s=slide('GIF','GIF внутри презентации','Движущийся зелёный круг. Сохранены кадры, интервалы и повтор GIF.','GIF');gif(s,'orbit')
s=slide('GIF-ALPHA','GIF с прозрачным фоном','Между кадрами нет следа статичного первого кадра. Цвет под GIF просвечивает.','GIF');s.addShape(pres.ShapeType.rect,{x:1,y:2,w:6.4,h:3.6,fill:{color:'704066'},line:{color:'704066'}});gif(s,'transparent')
s=slide('GIF-TWO','Два GIF на одном слайде','Оба изображения движутся одновременно, без видеотранспорта.','GIF');gif(s,'orbit',.7,2.2,5.8,3.26);gif(s,'transparent',6.8,2.2,5.8,3.26)
s=slide('GIF-CLICK','GIF появляется по клику','На первом шаге GIF скрыт. После клика появляется и начинает двигаться.','GIF');gif(s,'orbit')
s=slide('GIF-VIDEO','GIF и видео одновременно','GIF движется независимо от паузы видео. Автозапуск относится только к ролику.','GIF');video(s,'clip-a',.65,2.2,6,3.37);gif(s,'transparent',7,2.2,5.7,3.2)
s=slide('AFTER-GIF','Статика после GIF','Анимация предыдущего слайда исчезла. Вернитесь назад: GIF должен появиться снова.','GIF');card(s,'Никаких оставшихся слоёв\nПовторить переход назад и вперёд')
s=slide('OVERLAY','Один слой поверх эфира','В CueDeck откройте OVERLAY, задайте текст или картинку и включите показ. Слайд сам настройки приложения не меняет.','Управление');card(s,'Материал продолжает показываться\nТитр оператор включает отдельно')
s=slide('MOBILE','Кликер с телефона','Настройки → Кликер → Мобильный кликер. Телефон и ноутбук в одной сети; подключение по QR.','Управление');card(s,'Назад · вперёд\nНомер слайда и таймер спикера')
s=slide('CHECKS','Проверяем и показываем на одном файле','Для каждого прогона записываем ОС, сборку и результат. Наличие примера не означает, что он уже прошёл.','Итог');card(s,'Mac и Windows · превью и зал\nTAKE · назад/вперёд · повторное открытие')
fs.writeFileSync(path.join(root,'cases.json'),JSON.stringify(cases,null,2)+'\n')
pres.writeFile({fileName:path.join(root,'CueDeck-demo.pptx')})
