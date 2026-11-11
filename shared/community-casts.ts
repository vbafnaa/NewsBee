import type { SceneCast, ScenePoint, ScenePose } from "./community-scenes";

// Outlines and joint locations use the original 2172 × 724 paintings.
const point = (x: number, y: number): ScenePoint => [x / 2172, y / 724];
const pose = (at: number, x = 0, y = 0, rotation = 0, scale = 1): ScenePose => ({ at, x: x / 2172, y: y / 724, rotation, scale });
const reveal = (poses: readonly ScenePose[]): ScenePose[] => [
  { ...poses[0], opacity: 0 }, { ...poses[0], at: .04, opacity: 1 },
  ...poses.slice(1, -1).map(pose => ({ ...pose, opacity: 1 })),
  { ...poses.at(-1)!, at: .96, opacity: 1 }, { ...poses.at(-1)!, opacity: 0 },
];

export const WEDGWOOD_CAST = {
  backdrop: "wedgwood-welcome-backdrop-v1.webp",
  actors: [
    { id: "neighbor-left", pivot: point(1060, 538),
      outline: "M1063 421Q1072 420 1078 424L1082 425L1081 430L1077 431Q1080 441 1073 444L1075 448L1077 466L1080 489L1074 490L1078 531L1089 534Q1095 536 1087 539L1070 541L1067 536L1067 531L1064 532L1059 504L1044 529L1042 531L1047 537Q1046 542 1040 539L1032 535Q1028 531 1034 527L1049 507L1050 496Q1035 497 1028 490L1035 469L1043 469L1051 446L1057 441Q1054 438 1056 435Q1050 431 1055 428Q1052 421 1060 423Z" },
    { id: "neighbor-left-arm", parent: "neighbor-left", pivot: point(1074, 450),
      outline: "M1070 447Q1074 442 1081 448L1091 453L1100 447L1101 440L1103 435L1105 435L1106 432L1109 433L1109 436L1112 434L1113 437L1111 442L1107 447L1107 451L1098 460Q1094 464 1088 462L1073 457Z" },
    { id: "neighbor-right", pivot: point(1179, 538),
      outline: "M1164 421L1172 422Q1174 415 1182 417Q1190 419 1188 428L1185 433L1186 440L1196 445Q1200 453 1204 462L1210 477L1212 479L1215 483L1213 487L1207 485L1204 481L1200 482L1191 463L1192 482L1188 489L1190 501L1200 530L1201 534Q1205 539 1198 540L1186 542L1181 540L1188 535L1180 515L1173 532L1172 539L1165 542L1149 540Q1143 538 1150 534L1161 533L1168 504L1166 486L1161 485L1163 460L1165 448L1173 443L1173 439Q1166 436 1167 428L1162 426Q1157 422 1164 421Z" },
    { id: "neighbor-right-arm", parent: "neighbor-right", pivot: point(1171, 449),
      outline: "M1172 446L1155 451L1148 443L1146 437L1147 431L1144 429L1143 432L1141 426L1138 425L1138 430L1135 429L1134 433L1139 440L1141 446L1149 457Q1156 461 1168 458Z" },
    { id: "cafe-left", pivot: point(1511, 465), restOpacity: 0,
      outline: "M1497 465L1497 452Q1499 441 1506 438L1506 435Q1502 430 1507 426Q1514 421 1520 426L1521 430Q1520 435 1516 437L1516 441L1520 448L1521 458L1527 461L1529 465Z" },
    { id: "cafe-left-arm", parent: "cafe-left", pivot: point(1511, 445), restOpacity: 0,
      outline: "M1508 443Q1511 440 1514 444L1518 453L1524 453L1528 450L1530 451L1533 455L1527 456L1524 459L1516 458Q1512 455 1510 450Z" },
    { id: "cafe-right", pivot: point(1568, 465), restOpacity: 0,
      outline: "M1552 465L1554 461L1562 460L1563 451L1565 441L1568 438L1567 436Q1561 434 1563 427Q1567 421 1574 425Q1580 428 1576 435L1574 439Q1582 445 1582 455L1582 465Z" },
    { id: "cafe-right-arm", parent: "cafe-right", pivot: point(1569, 446), restOpacity: 0,
      outline: "M1567 443Q1572 443 1572 447L1567 456L1563 459L1555 459L1551 456L1548 455L1547 453L1552 453L1558 455L1562 451Z" },
  ],
  actions: [
    { id: "high-five", label: "High-five with the street neighbors", region: [0.515, 0.665, 0.05, 0.09], duration: 4200,
      tracks: [
        { actor: "neighbor-left", poses: [pose(0), pose(.3, 20, -1), pose(.52, 20, -2), pose(.8, 8), pose(1)] },
        { actor: "neighbor-right", poses: [pose(0), pose(.3, -14, -1), pose(.52, -14, -2), pose(.8, -5), pose(1)] },
        { actor: "neighbor-left-arm", poses: [pose(0), pose(.3, 0, 0, -15), pose(.4, 0, 0, -18), pose(.52, 0, 0, -14), pose(.8, 0, 0, -4), pose(1)] },
        { actor: "neighbor-right-arm", poses: [pose(0), pose(.3, 0, 0, -3), pose(.4, 0, 0, -6), pose(.52, 0, 0, -2), pose(.8), pose(1)] },
      ] },
    { id: "cafe-chat", label: "Start a conversation in the café", region: [0.709, 0.56, 0.062, 0.1], duration: 8200,
      tracks: [
        { actor: "cafe-left", poses: reveal([pose(0), pose(.16, 0, -1, 3), pose(.3, 0, 0, -2), pose(.5, 0, -1, 2), pose(.7, 0, 0, -1), pose(.86, 0, -1, 2), pose(1)]) },
        { actor: "cafe-right", poses: reveal([pose(0), pose(.16, 0, 0, -2), pose(.3, 0, -1, 2), pose(.5, 0, 0, -2), pose(.7, 0, -1, 2), pose(.86, 0, 0, -1), pose(1)]) },
        { actor: "cafe-left-arm", poses: reveal([pose(0), pose(.12, 0, 0, -20), pose(.23, 0, 0, -9), pose(.35), pose(.5, 0, 0, -24), pose(.62, 0, 0, -12), pose(.8, 0, 0, -18), pose(1)]) },
        { actor: "cafe-right-arm", poses: reveal([pose(0), pose(.14), pose(.28, 0, 0, 24), pose(.4, 0, 0, 12), pose(.55), pose(.68, 0, 0, 28), pose(.82, 0, 0, 14), pose(1)]) },
      ] },
  ],
} as const satisfies SceneCast;

export const MOSES_LAKE_CAST = {
  backdrop: "moses-lake-welcome-backdrop-v1.webp",
  actors: [
    { id: "shore-boat", pivot: point(850, 490),
      outline: "M751 458Q753 456 759 461Q786 466 815 463Q835 458 859 467L891 472L916 479L945 484Q952 482 951 488L938 503L934 505L926 501L914 503L814 497Q780 492 766 482Z M810 515Q823 502 835 501L896 463Q904 450 920 446Q934 442 934 450Q932 460 903 468L840 508L841 513Q830 524 811 520Z" },
  ],
  actions: [
    { id: "launch-boat", label: "Send the shore boat onto the lake", region: [0.392, 0.67, 0.055, 0.055], duration: 24000,
      tracks: [{ actor: "shore-boat", poses: [pose(0), pose(.12, 52, -20, -4, .92), pose(.35, 230, -68, -5, .68),
        pose(.58, 390, -60, 2, .62), pose(.76, 280, -52, 4, .73), pose(.9, 75, -24, 3, .92), pose(1)] }],
    },
  ],
} as const satisfies SceneCast;
