import type { SVGProps } from 'react';

/**
 * The panel's icon set.
 *
 * Generated from Material Symbols (Apache-2.0) by `scripts/generate-icons.mjs`
 * — do not edit by hand, run `pnpm --filter @hopper/web icons`.
 *
 * The paths are inlined rather than loaded from fonts.googleapis.com. A panel
 * people run themselves should not make every operator's browser announce to
 * Google when they open it, and an installation on a private network would show
 * no icons at all.
 *
 * These replaced a set of Unicode characters — `⌂ ⚙ ▦ ▤ ◍ ◫ ❐ ⚿ ⧉ ✎` — whose
 * appearance depended on whichever font the visitor happened to have. Several
 * had no relation to what they labelled, and the rarer ones rendered as a box
 * on systems that did not carry them.
 *
 * Material's grid is 960 wide with the origin at the baseline, hence the
 * viewBox. They are filled shapes, not strokes: setting `stroke` on them does
 * nothing.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden {...props}>
      {children}
    </svg>
  );
}

/** Material Symbols `dashboard`. */
export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M510-570v-270h330v270H510ZM120-450v-390h330v390H120Zm390 330v-390h330v390H510Zm-390 0v-270h330v270H120Zm60-390h210v-270H180v270Zm390 330h210v-270H570v270Zm0-450h210v-150H570v150ZM180-180h210v-150H180v150Zm210-330Zm180-120Zm0 180ZM390-330Z" />
    </Icon>
  );
}

/** Material Symbols `settings`. */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm48-60h88l14-112q33-8 62.5-25t53.5-41l106 46 40-72-94-69q4-17 6.5-33.5T715-480q0-17-2-33.5t-7-33.5l94-69-40-72-106 46q-23-26-52-43.5T538-708l-14-112h-88l-14 112q-34 7-63.5 24T306-642l-106-46-40 72 94 69q-4 17-6.5 33.5T245-480q0 17 2.5 33.5T254-413l-94 69 40 72 106-46q24 24 53.5 41t62.5 25l14 112Zm44-210q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Zm0-130Z" />
    </Icon>
  );
}

/** Material Symbols `dns`. */
export function NodesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M286.88-717q-20.88 0-35.38 14.62-14.5 14.62-14.5 35.5 0 20.88 14.62 35.38 14.62 14.5 35.5 14.5 20.88 0 35.38-14.62 14.5-14.62 14.5-35.5 0-20.88-14.62-35.38-14.62-14.5-35.5-14.5Zm0 414q-20.88 0-35.38 14.62-14.5 14.62-14.5 35.5 0 20.88 14.62 35.38 14.62 14.5 35.5 14.5 20.88 0 35.38-14.62 14.5-14.62 14.5-35.5 0-20.88-14.62-35.38-14.62-14.5-35.5-14.5ZM154-839h651q16 0 25.5 9.5t9.5 25.81V-535q0 17.42-9.5 29.21T805-494H154q-15 0-24.5-11.79T120-535v-268.69q0-16.31 9.5-25.81T154-839Zm26 60v225h600v-225H180Zm-26 353h647q15 0 27 12.5t12 28.53V-121q0 20-12 30.5T801-80H159q-16 0-27.5-10.5T120-121v-263.97q0-16.03 9.5-28.53T154-426Zm26 60v226h600v-226H180Zm0-413v225-225Zm0 413v226-226Z" />
    </Icon>
  );
}

/** Material Symbols `storage`. */
export function ServersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M120-160v-148h720v148H120Zm60-38h72v-72h-72v72Zm-60-454v-148h720v148H120Zm60-38h72v-72h-72v72Zm-60 284v-148h720v148H120Zm60-38h72v-72h-72v72Z" />
    </Icon>
  );
}

/** Material Symbols `group`. */
export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M38-160v-94q0-35 18-63.5t50-42.5q73-32 131.5-46T358-420q62 0 120 14t131 46q32 14 50.5 42.5T678-254v94H38Zm700 0v-94q0-63-32-103.5T622-423q69 8 130 23.5t99 35.5q33 19 52 47t19 63v94H738ZM250-523q-42-42-42-108t42-108q42-42 108-42t108 42q42 42 42 108t-42 108q-42 42-108 42t-108-42Zm426 0q-42 42-108 42-11 0-24.5-1.5T519-488q24-25 36.5-61.5T568-631q0-45-12.5-79.5T519-774q11-3 24.5-5t24.5-2q66 0 108 42t42 108q0 66-42 108ZM98-220h520v-34q0-16-9.5-31T585-306q-72-32-121-43t-106-11q-57 0-106.5 11T130-306q-14 6-23 21t-9 31v34Zm324.5-346.5Q448-592 448-631t-25.5-64.5Q397-721 358-721t-64.5 25.5Q268-670 268-631t25.5 64.5Q319-541 358-541t64.5-25.5ZM358-220Zm0-411Z" />
    </Icon>
  );
}

/** Material Symbols `database`. */
export function DatabaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M480-120q-151 0-255.5-46.5T120-280v-400q0-66 105.5-113T480-840q149 0 254.5 47T840-680v400q0 67-104.5 113.5T480-120Zm0-488q86 0 176.5-26.5T773-694q-27-32-117.5-59T480-780q-88 0-177 26t-117 60q28 35 116 60.5T480-608Zm-1 214q42 0 84-4.5t80.5-13.5q38.5-9 73.5-22t63-29v-155q-29 16-64 29t-74 22q-39 9-80 14t-83 5q-42 0-84-5t-80.5-14q-38.5-9-73-22T180-618v155q27 16 61 29t72.5 22q38.5 9 80.5 13.5t85 4.5Zm1 214q48 0 99-8.5t93.5-22.5q42.5-14 72-31t35.5-35v-125q-28 16-63 28.5T643.5-352q-38.5 9-80 13.5T479-334q-43 0-85-4.5T313.5-352q-38.5-9-72.5-21.5T180-402v126q5 17 34 34.5t72 31q43 13.5 94 22t100 8.5Z" />
    </Icon>
  );
}

/** Material Symbols `deployed_code`. */
export function TemplatesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M450-154v-309L180-619v309l270 156Zm60 0 270-156v-310L510-463.16V-154Zm-30-360 266-155-266-154-267 154 267 155ZM150-258q-14.25-8.43-22.12-22.21Q120-294 120-310v-340q0-16 7.88-29.79Q135.75-693.57 150-702l300-173q14.33-8 30.16-8 15.84 0 29.84 8l300 173q14.25 8.43 22.13 22.21Q840-666 840-650v340q0 16-7.87 29.79Q824.25-266.43 810-258L510-85q-14.33 8-30.16 8Q464-77 450-85L150-258Zm330-222Z" />
    </Icon>
  );
}

/** Material Symbols `search`. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M796-121 533-384q-30 26-70 40.5T378-329q-108 0-183-75t-75-181q0-106 75-181t182-75q106 0 180.5 75T632-585q0 43-14 83t-42 75l264 262-44 44ZM377-389q81 0 138-57.5T572-585q0-81-57-138.5T377-781q-82 0-139.5 57.5T180-585q0 81 57.5 138.5T377-389Z" />
    </Icon>
  );
}

/** Material Symbols `language`. */
export function LanguageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M323-111.5Q250-143 196-197t-85-127.5Q80-398 80-482t31-156.5Q142-711 196-765t127-84.5Q396-880 480-880t157 30.5Q710-819 764-765t85 126.5Q880-566 880-482t-31 157.5Q818-251 764-197t-127 85.5Q564-80 480-80t-157-31.5ZM480-138q35-36 58.5-82.5T577-331H384q14 60 37.5 108t58.5 85Zm-85-12q-25-38-43-82t-30-99H172q38 71 88 111.5T395-150Zm171-1q72-23 129.5-69T788-331H639q-13 54-30.5 98T566-151ZM152-391h159q-3-27-3.5-48.5T307-482q0-25 1-44.5t4-43.5H152q-7 24-9.5 43t-2.5 45q0 26 2.5 46.5T152-391Zm221 0h215q4-31 5-50.5t1-40.5q0-20-1-38.5t-5-49.5H373q-4 31-5 49.5t-1 38.5q0 21 1 40.5t5 50.5Zm275 0h160q7-24 9.5-44.5T820-482q0-26-2.5-45t-9.5-43H649q3 35 4 53.5t1 34.5q0 22-1.5 41.5T648-391Zm-10-239h150q-33-69-90.5-115T565-810q25 37 42.5 80T638-630Zm-254 0h194q-11-53-37-102.5T480-820q-32 27-54 71t-42 119Zm-212 0h151q11-54 28-96.5t43-82.5q-75 19-131 64t-91 115Z" />
    </Icon>
  );
}

/** Material Symbols `power_settings_new`. */
export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-84 32-156.5T198-763l42 42q-47 46-73.5 108T140-480q0 141 99.5 240.5T480-140q142 0 241-99.5T820-480q0-71-26-133t-73-108l42-42q54 54 85.5 126.5T880-480q0 82-31.5 155T763-197.5q-54 54.5-127 86T480-80Zm-30-360v-440h60v440h-60Z" />
    </Icon>
  );
}

/** Material Symbols `chevron_left`. */
export function PreviousIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M561-240 320-481l241-241 43 43-198 198 198 198-43 43Z" />
    </Icon>
  );
}

/** Material Symbols `chevron_right`. */
export function NextIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M530-481 332-679l43-43 241 241-241 241-43-43 198-198Z" />
    </Icon>
  );
}

/** Material Symbols `lan`. */
export function AddressIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M120-80v-270h120v-160h210v-100H330v-270h300v270H510v100h210v160h120v270H540v-270h120v-100H300v100h120v270H120Zm270-590h180v-150H390v150ZM180-140h180v-150H180v150Zm420 0h180v-150H600v150ZM480-670ZM360-290Zm240 0Z" />
    </Icon>
  );
}

/** Material Symbols `schedule`. */
export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m627-287 45-45-159-160v-201h-60v225l174 181ZM480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-82 31.5-155t86-127.5Q252-817 325-848.5T480-880q82 0 155 31.5t127.5 86Q817-708 848.5-635T880-480q0 82-31.5 155t-86 127.5Q708-143 635-111.5T480-80Zm0-400Zm0 340q140 0 240-100t100-240q0-140-100-240T480-820q-140 0-240 100T140-480q0 140 100 240t240 100Z" />
    </Icon>
  );
}

/** Material Symbols `developer_board`. */
export function CpuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M150-120q-24 0-42-18t-18-42v-600q0-24 18-42t42-18h600q24 0 42 18t18 42v60h60v60h-60v150h60v60h-60v150h60v60h-60v60q0 24-18 42t-42 18H150Zm0-60h600v-600H150v600Zm60-60h253v-200H210v200Zm283-336h197v-144H493v144ZM210-470h253v-250H210v250Zm283 230h197v-306H493v306ZM150-780v600-600Z" />
    </Icon>
  );
}

/** Material Symbols `memory`. */
export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M377-377v-205h205v205H377Zm60-60h85v-85h-85v85Zm-77 317v-80H260q-24 0-42-18t-18-42v-100h-80v-60h80v-124h-80v-60h80v-100q0-24 18-42t42-18h100v-76h60v76h124v-76h60v76h100q24 0 42 18t18 42v100h76v60h-76v124h76v60h-76v100q0 24-18 42t-42 18H604v80h-60v-80H420v80h-60Zm344-140v-444H260v444h444ZM480-480Z" />
    </Icon>
  );
}

/** Material Symbols `hard_drive`. */
export function DiskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M140-260h680v-280H140v280Zm575.5-104.62q14.5-14.62 14.5-35.5 0-20.88-14.62-35.38-14.62-14.5-35.5-14.5-20.88 0-35.38 14.62-14.5 14.62-14.5 35.5 0 20.88 14.62 35.38 14.62 14.5 35.5 14.5 20.88 0 35.38-14.62ZM880-600h-85L695-700H265L165-600H80l142-142q8-8 19.28-13 11.28-5 23.72-5h430q12.44 0 23.72 5T738-742l142 142ZM140-200q-24.75 0-42.37-17.63Q80-235.25 80-260v-340h800v340q0 24.75-17.62 42.37Q844.75-200 820-200H140Z" />
    </Icon>
  );
}

/** Material Symbols `download`. */
export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M480-313 287-506l43-43 120 120v-371h60v371l120-120 43 43-193 193ZM220-160q-24 0-42-18t-18-42v-143h60v143h520v-143h60v143q0 24-18 42t-42 18H220Z" />
    </Icon>
  );
}

/** Material Symbols `upload`. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M450-313v-371L330-564l-43-43 193-193 193 193-43 43-120-120v371h-60ZM220-160q-24 0-42-18t-18-42v-143h60v143h520v-143h60v143q0 24-18 42t-42 18H220Z" />
    </Icon>
  );
}

/** Material Symbols `edit`. */
export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M180-180h44l472-471-44-44-472 471v44Zm-60 60v-128l575-574q8-8 19-12.5t23-4.5q11 0 22 4.5t20 12.5l44 44q9 9 13 20t4 22q0 11-4.5 22.5T823-694L248-120H120Zm659-617-41-41 41 41Zm-105 64-22-22 44 44-22-22Z" />
    </Icon>
  );
}

/** Material Symbols `edit_square`. */
export function RenameIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M180-120q-24 0-42-18t-18-42v-600q0-24 18-42t42-18h405l-60 60H180v600h600v-348l60-60v408q0 24-18 42t-42 18H180Zm300-360ZM360-360v-170l382-382q9-9 20-13t22-4q11 0 22.32 4.5Q817.63-920 827-911l83 84q8.61 8.96 13.3 19.78 4.7 10.83 4.7 22.02 0 11.2-4.5 22.7T910-742L530-360H360Zm508-425-84-84 84 84ZM420-420h85l253-253-43-42-43-42-252 251v86Zm295-295-43-42 43 42 43 42-43-42Z" />
    </Icon>
  );
}

/** Material Symbols `content_copy`. */
export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M300-200q-24 0-42-18t-18-42v-560q0-24 18-42t42-18h440q24 0 42 18t18 42v560q0 24-18 42t-42 18H300Zm0-60h440v-560H300v560ZM180-80q-24 0-42-18t-18-42v-620h60v620h500v60H180Zm120-180v-560 560Z" />
    </Icon>
  );
}

/** Material Symbols `key`. */
export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M232-432q-20-20-20-48t20-48q20-20 48-20t48 20q20 20 20 48t-20 48q-20 20-48 20t-48-20Zm48 192q-100 0-170-70T40-480q0-100 70-170t170-70q72 0 126 34t85 103h356l113 113-167 153-88-64-88 64-75-60h-51q-25 60-78.5 98.5T280-240Zm0-60q58 0 107-38.5t63-98.5h114l54 45 88-63 82 62 85-79-51-51H450q-12-56-60-96.5T280-660q-75 0-127.5 52.5T100-480q0 75 52.5 127.5T280-300Z" />
    </Icon>
  );
}

/** Material Symbols `folder_zip`. */
export function CompressIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M640-496v-92h92v92h-92Zm0 92h-92v-92h92v92Zm0 92v-92h92v92h-92ZM456-680l-60-60H140v520h408v-92h92v92h180v-460H640v92h-92v-92h-92ZM140-160q-24 0-42-18.5T80-220v-520q0-23 18-41.5t42-18.5h281l60 60h339q23 0 41.5 18.5T880-680v460q0 23-18.5 41.5T820-160H140Zm0-60v-520 520Z" />
    </Icon>
  );
}

/** Material Symbols `unarchive`. */
export function ExtractIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M480-581 324-425l40 40 86-86v201h60v-201l86 86 40-40-156-156Zm-300-93v494h600v-494H180Zm0 554q-24.75 0-42.37-17.63Q120-155.25 120-180v-529q0-9.88 3-19.06 3-9.18 9-16.94l52-71q8-11 20.94-17.5Q217.88-840 232-840h495q14.12 0 27.06 6.5T775-816l53 71q6 7.76 9 16.94 3 9.18 3 19.06v529q0 24.75-17.62 42.37Q804.75-120 780-120H180Zm17-614h565l-36.41-46H233l-36 46Zm283 307Z" />
    </Icon>
  );
}

/** Material Symbols `delete`. */
export function DeleteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M261-120q-24.75 0-42.37-17.63Q201-155.25 201-180v-570h-41v-60h188v-30h264v30h188v60h-41v570q0 24-18 42t-42 18H261Zm438-630H261v570h438v-570ZM367-266h60v-399h-60v399Zm166 0h60v-399h-60v399ZM261-750v570-570Z" />
    </Icon>
  );
}
