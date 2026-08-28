# FlacDeck

Desktop-app voor Windows en macOS die YouTube-links omzet naar getagde FLAC-bestanden,
en die uit een livestream-opname of dj-set losse nummers knipt op de tijden die jij opgeeft.
Klaar voor export naar een USB-stick in de mapindeling die je apparaat begrijpt.

## Wat het doet

- **Link erin, FLAC eruit.** Plak een YouTube-URL, FlacDeck haalt titel, artiest, jaar en
  hoesafbeelding op en schrijft die als Vorbis-tags in het bestand.
- **Knippen op tijd.** Geef per nummer een begin- en eindtijd (`4:12`, `1:02:30` of gewoon
  seconden). Leeg laten betekent "vanaf het begin" of "tot het eind".
- **Tracklist automatisch overnemen.** Heeft de video hoofdstukken, dan worden dat de nummers.
  Zo niet, dan leest FlacDeck de tijdstempels uit de videobeschrijving. Je kunt ook een
  tracklist plakken — met de tijd vooraan of achteraan, met of zonder nummering.
- **Alles in één keer.** Uit één set van drie uur haal je in één run twintig losse tracks;
  de bron wordt maar één keer gedownload.
- **USB-export.** Vier mapindelingen, waaronder één voor Pioneer- en Denon-spelers, met
  een waarschuwing als de stick een bestandssysteem heeft dat je speler niet leest.

## Eerlijk over de kwaliteit

YouTube levert altijd gecomprimeerde audio (Opus of AAC, meestal ~130 kbit/s). FLAC bewaart
dát signaal verliesvrij, maar tovert er geen cd-kwaliteit van. Voor een set die nergens anders
te krijgen is, is dit prima; koop een track die je vaak draait gewoon bij de bron.

Wat je downloadt is jouw verantwoordelijkheid — respecteer de rechten van de makers.

## Installeren

### Vanaf de broncode

```bash
npm install
npm run dev        # app starten in ontwikkelmodus
npm run build      # bundelen zonder installer te maken
npm run pack:win   # Windows-installer in dist/
npm run pack:mac   # macOS-dmg in dist/  (moet op een Mac draaien)
```

### De macOS-versie laten bouwen door GitHub

Je hebt zelf **geen Mac nodig**. GitHub heeft Macs staan die de `.dmg` voor je bouwen, gratis
voor een openbare repo. Jij pusht een tag, en tien minuten later staat er een downloadlink.

**Eenmalig instellen:**

1. Maak op [github.com/new](https://github.com/new) een repo met de naam **`flacdeck`**, zet
   hem op **Public** en vink alles bij "Initialize" uít.
2. Koppel dit project eraan en push:

   ```bash
   git remote add origin https://github.com/RubenJan1/flacdeck.git
   git push -u origin main
   ```

   Vraagt hij om een wachtwoord: dat is niet je GitHub-wachtwoord, maar een *personal access
   token*. Maak er een via **Settings → Developer settings → Personal access tokens → Tokens
   (classic) → Generate new token**, met het vakje **repo** aangevinkt. Plak die als
   wachtwoord.

Heet je GitHub-account anders dan `RubenJan1`, pas dan de `owner:` in `electron-builder.yml`
en de `repository` in `package.json` aan.

**Een versie uitbrengen — dit is voortaan alles wat je doet:**

```bash
npm run check:release      # kijkt of de instellingen kloppen
npm version patch          # 1.0.0 -> 1.0.1 (of: minor / major)
git push --follow-tags
```

GitHub bouwt nu Windows én macOS, en zet in de release:

| Bestand | Voor wie |
| --- | --- |
| `FlacDeck-1.0.1-windows-x64.exe` | Windows |
| `FlacDeck-1.0.1-macos-arm64.dmg` | Macs met M1 t/m M4 |
| `FlacDeck-1.0.1-macos-x64.dmg` | oudere Intel-Macs |

Volgen kan onder het tabblad **Actions**. Is het klaar, dan staat de release op
`github.com/RubenJan1/flacdeck/releases/latest` — die link kun je gewoon doorsturen. De
ontvanger downloadt de `.dmg`, sleept FlacDeck naar Programma's, en klaar. Verder hoeft
niemand iets te doen behalve de sleutel plakken die jij hebt gestuurd.

**Bijwerken gaat vanzelf.** De app kijkt bij het starten of er een nieuwere versie is en meldt
dat in de zijbalk. Eén klik downloadt hem, nog een klik herstart de app. Jij hoeft dus nooit
meer een installer rond te sturen — alleen `npm version patch` en pushen.

### De macOS-versie zelf bouwen (alternatief)

Heb je toevallig een Mac en wil je niet via GitHub? Dan kan het ook met de hand:

1. Installeer **Node.js 20 of hoger** via [nodejs.org](https://nodejs.org).
2. Zet de projectmap erop — via een USB-stick, AirDrop of een zip. **Laat `node_modules`,
   `dist`, `out` en `keys` thuis.** `node_modules` bevat Windows-versies van ffmpeg, en je
   geheime ondertekensleutel hoeft daar niet te komen; voor het bouwen is alleen
   `shared/licence-key.ts` (de publieke helft) nodig, en die zit gewoon in het project.
3. Open Terminal in de projectmap en draai:

   ```bash
   bash tools/bouw-op-mac.sh
   ```

   Dat installeert de pakketten opnieuw (nu met de macOS-binaries), controleert alles en
   zet twee installers in `dist/`: één voor Apple Silicon (M1 t/m M4) en één voor de oudere
   Intel-Macs. Weet je niet welke: Apple-menu → Over deze Mac.

Alleen even kijken of hij werkt, zonder installer? `npm install && npm run dev`.

**De app is niet ondertekend.** Zonder Apple Developer-account (€99 per jaar) kun je niet
ondertekenen en notariseren. Gevolg: de eerste keer weigert macOS de app te openen. Dat lost
de gebruiker zo op:

- Rechtermuisknop op **FlacDeck.app** → **Open** → in het venster nogmaals **Open**.
- Lukt dat niet, dan in Terminal: `xattr -dr com.apple.quarantine /Applications/FlacDeck.app`

Daarna start hij normaal. Wil je dat mensen daar helemaal niets van merken, dan is een
Apple Developer-account de enige weg.

**Windows: "Cannot create symbolic link" bij `pack:win`.** electron-builder pakt zijn
signeergereedschap uit met symlinks erin, en dat mag Windows standaard niet zonder extra
rechten. Twee oplossingen:

- Zet **ontwikkelaarsmodus** aan (Instellingen → Privacy en beveiliging → Voor ontwikkelaars), of
- draai `npm run pack:win` één keer in een terminal **als administrator**.

`npx electron-builder --win --dir` werkt wel zonder: dat levert een draaiende app in
`dist/win-unpacked/` op, alleen zonder installer.

Voor het uitbrengen van een versie hoef je dit niet op te lossen: GitHub bouwt de
Windows-installer op zijn eigen machine, waar dit probleem niet speelt.

## Toegangssleutels

De app doet niets tot er een geldige sleutel is ingevoerd. Sleutels geef jij uit; niemand
anders kan ze maken.

### Eenmalig instellen

```bash
npm run licence:init
```

Dit maakt een sleutelpaar. De geheime helft komt in `keys/private.pem`, de publieke helft
wordt in `shared/licence-key.ts` gezet en gaat mee de app in.

> **Bewaar een back-up van `keys/private.pem`.** Raak je hem kwijt, dan kun je geen nieuwe
> sleutels meer uitgeven — bestaande blijven wel werken. `keys/` staat in `.gitignore` en
> hoort nooit gedeeld of meegekopieerd te worden. Draai `licence:init` ook nooit een tweede
> keer: dat maakt álle uitgegeven sleutels in één klap ongeldig.

Dit is al voor je gedaan; er is een sleutelpaar aangemaakt en één sleutel op jouw naam
uitgegeven, die al op deze computer staat.

### Een sleutel uitgeven

```bash
npm run licence:issue -- --naam "Jan Jansen"
npm run licence:issue -- --naam "Piet" --email piet@x.nl --verloopt 2027-01-01 --notitie "proef"
```

Je krijgt een regel die begint met `FD1.` — die stuur je door. De ontvanger plakt hem één keer
in het startscherm; daarna onthoudt de app hem. Elke uitgifte wordt bijgeschreven in
`keys/uitgegeven.csv`, zodat je kunt terugzien wie wat heeft.

```bash
npm run licence:list                # wat heb ik uitgegeven
npm run licence:verify -- "FD1.…"   # klopt deze sleutel nog
```

Een sleutel zonder `--verloopt` is onbeperkt geldig. Bij elke start controleert de app de
datum opnieuw, dus een verlopen sleutel sluit de deur vanzelf.

### Wat dit wel en niet is

Het is een drempel, geen kluis.

- **Wél:** niemand kan zelf geldige sleutels maken. Daarvoor is jouw geheime sleutel nodig.
  Knoeien met de naam of de datum in een bestaande sleutel breekt de handtekening meteen.
  De controle zit ook in het hoofdproces, niet alleen in het scherm — de knoppen wegklikken
  met de ontwikkelaarsconsole levert dus niets op.
- **Niet:** wie de app uitpakt en de code aanpast, komt er langs. Dat geldt voor élke
  desktop-app zonder server, want de controle draait nu eenmaal op de computer van de ander.
  Wil je écht kunnen intrekken en meekijken wie hem gebruikt, dan heb je online activatie
  nodig — en dus iets om te hosten.
- Een sleutel is niet aan een computer gebonden: wie hem doorgeeft, geeft toegang door. Zijn
  naam zit er wel in, dus je kunt zien waar een gelekte sleutel vandaan kwam.

Bij een **openbare** repo is de broncode zichtbaar, dus iemand met verstand van zaken kan de
sleutelcontrole eruit halen en zelf een versie bouwen. Dat is de prijs voor gratis Mac-builds
en downloadlinks die zonder GitHub-account werken. Vind je dat bezwaarlijk, zet de repo dan op
**Private**: de broncode is dan afgeschermd, maar downloaden vereist een GitHub-account met
toegang (je haalt de installers dan zelf op en stuurt ze door), automatisch bijwerken vervalt,
en Mac-builds tellen tienvoudig mee in de gratis minuten — grofweg 15 tot 20 builds per maand.

## Eerste start

FlacDeck heeft `yt-dlp` nodig en haalt die bij de eerste start zelf op van GitHub (±15 MB,
komt in je gebruikersmap, geen beheerdersrechten nodig). ffmpeg zit al in de app.

Werkt dat niet door een firewall of proxy? Zet `yt-dlp` er dan handmatig neer:

| Systeem | Locatie |
| --- | --- |
| Windows | `%APPDATA%\flacdeck\bin\yt-dlp.exe` |
| macOS | `~/Library/Application Support/flacdeck/bin/yt-dlp` (maak hem uitvoerbaar met `chmod +x`) |

Werkt een download plotseling niet meer? YouTube verandert regelmatig iets — klik dan op
**Instellingen → yt-dlp bijwerken**. Dat is bijna altijd de oplossing.

### Blijft macOS om yt-dlp vragen?

FlacDeck controleert na het downloaden meteen of yt-dlp ook echt start, en onthoudt dat in
`~/Library/Application Support/flacdeck/bin/yt-dlp.json`. Blijft het installatiescherm toch
terugkomen, dan staat de echte reden op datzelfde scherm en bij **Instellingen → Onderdelen**.
Zelf nakijken in Terminal:

```bash
cd ~/Library/Application\ Support/flacdeck/bin
ls -l yt-dlp && xattr -l yt-dlp
./yt-dlp --version
```

* `Bad CPU type` of een dyld-fout → je macOS is ouder dan 12; klik **Opnieuw installeren**, dan
  pakt FlacDeck vanzelf de legacy-build.
* `Operation not permitted` of "killed" → quarantaine: `xattr -d com.apple.quarantine yt-dlp`.
* `Permission denied` → `chmod +x yt-dlp`.
* Duurt de eerste `--version` heel lang? Dat is normaal: yt-dlp pakt zichzelf één keer uit.

## Een nummer uit een livestream halen

1. Plak de link van de opname en klik **Analyseren**.
2. Zijn er hoofdstukken of een tracklist in de beschrijving? Dan staan de nummers er al.
   Anders: **Hele video = 1 track** of **+ Rij**, en vul de tijden zelf in.
3. Vink af wat je wilt hebben, corrigeer artiest en titel.
4. Vul onder **Tags voor alle tracks** eventueel album, genre en jaar in.
5. **In wachtrij zetten**. De bron wordt één keer opgehaald, daarna wordt elk stuk geknipt.

Staat de stream nog *live*? Dan kan er alleen geknipt worden binnen het stuk dat YouTube
terugbewaart. Wachten tot de opname na afloop online staat geeft een exacte knip.

## USB-export

Op het tabblad **Bibliotheek & USB** vink je aan wat mee moet, kies je de schijf en de indeling:

| Indeling | Structuur |
| --- | --- |
| DJ-speler (Pioneer / Denon) | `Contents/Artiest/Album/02 Artiest - Titel.flac` |
| Auto / hifi USB-speler | `Music/Artiest/Album/02 - Titel.flac`, korte ASCII-namen |
| Alles in één map | `Artiest - Titel.flac` in de hoofdmap |
| Bibliotheek | `Muziek/Genre/Artiest/Album/02 - Titel.flac` |

Aandachtspunten voor dj-spelers:

- **Formatteer de stick als FAT32 of exFAT.** NTFS (Windows) en APFS/HFS+ (Mac) worden niet
  gelezen. FlacDeck waarschuwt als het dat kan zien.
- FlacDeck zet de bestanden en de tags klaar. **Rekordbox of Engine DJ moet er daarna nog
  overheen** om zijn eigen database op de stick te zetten en BPM en toonsoort te analyseren.
  Laat de BPM- en toonsoortvelden dus gerust leeg.
- Al gekopieerde nummers worden overgeslagen, ook als ze eerder een `(2)`-achtervoegsel
  kregen. Je kunt dus zonder zorgen opnieuw exporteren.

## Instellingen die ertoe doen

- **Samplerate 44,1 kHz** — de dj-standaard. `Zoals de bron` levert meestal 48 kHz.
- **Volume gelijktrekken** — laat uit voor dj-gebruik; rekordbox en Engine regelen gain zelf.
- **Cookies uit browser** — nodig voor video's met leeftijdscheck of ledencontent. De browser
  moet dan wel dicht zijn.
- **Bronbestanden bewaren** — handig als je later nog een nummer uit dezelfde set wilt knippen
  zonder opnieuw te downloaden.

## Ontwikkelen

```
electron/          hoofdproces
  services/
    binaries.ts    ffmpeg/ffprobe vinden, yt-dlp ophalen en bijwerken
    ytdlp.ts       video-informatie ophalen en audio downloaden
    audio.ts       knippen, naar FLAC encoderen, taggen, hoes inbedden
    tracklist.ts   hoofdstukken en tijdstempels omzetten naar segmenten
    naming.ts      bestandsnamen die op FAT32 en DJ-spelers werken
    licence.ts     toegangssleutels controleren
    updater.ts     nieuwe versies zoeken en installeren
    usb.ts         schijven vinden, mapindelingen, kopiëren, playlist
    library.ts     de outputmap uitlezen
    queue.ts       taken plannen, voortgang, annuleren
src/               React-interface
shared/types.ts    types die beide kanten delen
test/              tests
tools/
  licence.mjs      sleutels uitgeven en nakijken
  bouw-op-mac.sh   macOS-installers met de hand bouwen (op een Mac)
  check-release.mjs  controleert de instellingen voor het uitbrengen
```

```bash
npm run typecheck
npm test           # alles
npm run test:unit  # parser en bestandsnamen, geen netwerk
npm run test:licence  # sleutelcontrole, inclusief namaakpogingen
npm run test:usb   # exportindelingen, maakt echte FLAC-bestanden
npm run test:e2e   # haalt een korte publieke video op en knipt die
```

`npm run test:e2e` gebruikt het netwerk. Overslaan kan met `SKIP_NETWORK=1`.

### Waarom de hele bron wordt gedownload

yt-dlp kan met `--download-sections` alleen een stuk ophalen, maar geen van beide varianten
is bruikbaar: zonder `--force-keyframes-at-cuts` knipt het alleen op clustergrenzen (je krijgt
meer dan je vroeg, met een onbekende offset), en mét die vlag hercodeert het de audio opnieuw
naar Opus — dus verlies bovenop verlies. De hele bron ophalen en zelf met ffmpeg knippen kost
wat meer bandbreedte, maar audio is klein, één download bedient alle segmenten, en de knip is
exact en verliesvrij.
