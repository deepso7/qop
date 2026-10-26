import {
  AmbientLight,
  DirectionalLight,
  Group,
  OrthographicCamera,
  Scene,
  Vector3,
} from "three";
import type { Object3D } from "three";

import { makeIsland } from "./island";
import { kits, makePerson } from "./people";
import {
  ABSORB,
  AD_TIME,
  cctv,
  PUZZLED_TIME,
  arc,
  everyone,
  hoard,
  island,
  LOOP,
  lerp3,
  oldMessages,
  people,
  progress,
  q2Walk,
  qopMessages,
  sample,
  smooth,
  tower,
} from "./play";
import type { Facing, Vec3, Who } from "./play";
import { RES } from "./post";
import {
  makeAd,
  makeBlob,
  makeBubble,
  makeCctv,
  makeCopy,
  makeFlowers,
  makeHeart,
  makeHoard,
  makeQuestion,
  makeTower,
  makeTree,
} from "./props";

/** World units visible across the low-res frame. */
const VIEW = 35;
const PX = VIEW / RES;

// The sun: mostly overhead, a little in front. Tops land on full light, the
// left faces just under it and the right faces between shade and shadow.
const SUN = new Vector3(0.11, 0.85, 0.52).normalize();

const camera = new OrthographicCamera(
  -VIEW / 2,
  VIEW / 2,
  VIEW / 2,
  -VIEW / 2,
  1,
  200
);

camera.position.set(60, 60, 60);

camera.lookAt(0, 0, 0);

camera.position.add(new Vector3(0, 1.8, 0));

camera.updateMatrixWorld();

const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

const half = island.size / 2;
const v = new Vector3();

/**
 * Puts an object at a cell-space position, snapped to the low-res pixel grid
 * on screen. Moving things then rasterise identically every time they pass a
 * spot, so nothing shimmers.
 */
const place = (o: Object3D, [x, y, z]: Vec3) => {
  v.set(x - half, y, z - half);
  const a = v.dot(right);
  const b = v.dot(up);
  v.addScaledVector(right, Math.round(a / PX) * PX - a).addScaledVector(
    up,
    Math.round(b / PX) * PX - b
  );
  o.position.set(v.x + half, v.y, v.z + half);
};

/** Where a person's phone is, for bubbles to leave from and land on. */
const phoneOf = (at: Vec3, facing: Facing): Vec3 => {
  const [dx, dz] = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ][facing];

  return [at[0] + dx * 0.9, at[1] + 3.2, at[2] + dz * 0.9];
};

/** Just above someone's head, where incoming messages land. */
const above = (at: Vec3): Vec3 => [at[0], at[1] + 6.5, at[2]];

const inside = (t: number, a: number, b: number) => t >= a && t < b;

/** Turns a world offset into a -1/0/1 step for the pupil. */
const step = (d: number) => Math.max(-1, Math.min(1, Math.round(d / 3)));

interface Spot {
  at: Vec3;
  facing: Facing;
  walk: number | null;
}

/** Where someone stands and which way they face. Only Q2 ever moves. */
const spotOf = (who: Who, t: number): Spot => {
  const { at, facing } = people[who];

  if (who !== "Q2") {
    return { at, facing, walk: null };
  }

  const walked = sample(q2Walk.keys, t);
  const position = lerp3(q2Walk.from, at, walked);

  if (walked === 1) {
    return { at: position, facing, walk: null };
  }

  if (walked === 0) {
    return { at: position, facing: 0, walk: null };
  }

  // Walking in faces the camera; walking back out faces away.
  return { at: position, facing: t < LOOP / 2 ? 0 : 2, walk: walked * 8 };
};

/** Old-app people flinch at an ad; qop people do two happy hops. */
const hopOf = (who: Who, t: number) => {
  const ad = oldMessages.find(
    (m) => m.to === who && inside(t, m.arrive, m.arrive + 0.12)
  );

  if (ad) {
    return 0.5;
  }

  const got = qopMessages.find(
    (m) => m.to === who && inside(t, m.arrive, m.arrive + 0.5)
  );

  return got && Math.floor((t - got.arrive) * 8) % 2 === 0 ? 1 : 0;
};

const isTyping = (who: Who, t: number) =>
  [...oldMessages, ...qopMessages].some(
    (m) => m.from === who && inside(t, m.send - 0.6, m.send)
  ) && Math.floor(t * 8) % 2 === 0;

// Where the tower holds a message while it reads it: beside the eye, not over it.
const readingSpot: Vec3 = [
  tower.eye[0] + 4,
  tower.eye[1] - 1,
  tower.eye[2] + 0.5,
];

const copyFrom: Vec3 = [tower.eye[0], tower.eye[1] - 1.5, tower.eye[2] + 1];

type OldMessage = (typeof oldMessages)[number];

/** An old-app message: up to the tower, held while it's read, then down to the friend. */
const oldPath = (m: OldMessage, t: number, from: Vec3, to: Vec3): Vec3 => {
  if (t < m.read) {
    return arc(from, readingSpot, smooth(progress(t, m.send, m.read)), 1.5);
  }

  if (t < m.leave) {
    return readingSpot;
  }

  return arc(readingSpot, to, smooth(progress(t, m.leave, m.arrive)), 1);
};

/** Shows a bubble and its ground shadow at p, or hides both. */
const show = (b: { o: Object3D; blob: Object3D }, p: Vec3 | null) => {
  b.o.visible = p !== null;
  b.blob.visible = p !== null;

  if (p) {
    place(b.o, [p[0], p[1], p[2] - 0.5]);
    place(b.blob, [p[0], 0.02, p[2]]);
  }
};

/** Builds the scene. `frame(t)` poses everything for loop time t in [0, LOOP). */
export const createDiorama = () => {
  const scene = new Scene();
  scene.add(new AmbientLight(0xff_ff_ff, 0.5 * Math.PI));
  const sun = new DirectionalLight(0xff_ff_ff, 0.68 * Math.PI);
  sun.position.copy(SUN).multiplyScalar(40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -16,
    right: 16,
    top: 16,
    bottom: -16,
    near: 1,
    far: 100,
  });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2;
  scene.add(sun);

  // Everything below is built in island cells; this shifts cells to world.
  const world = new Group();
  world.position.set(-half, 0, -half);
  scene.add(world);

  const ground = makeIsland();
  const eye = makeTower();
  const street = makeCctv();
  world.add(
    ground.group,
    eye.group,
    street.group,
    makeTree(),
    makeFlowers(),
    makeHoard()
  );

  const castOf = (who: Who) => {
    const { outfit, skin, hair } = people[who];
    const person = makePerson(kits[outfit], { skin, hair });
    world.add(person.root);

    return person;
  };

  const cast = {
    L1: castOf("L1"),
    L2: castOf("L2"),
    Q1: castOf("Q1"),
    Q2: castOf("Q2"),
  };

  const withBlob = (o: Object3D, r: number) => {
    const blob = makeBlob(r);
    world.add(o, blob);

    return { o, blob };
  };

  const olds = oldMessages.map((m, i) => {
    const slot: Vec3 = [hoard.base[0] + 1 - i, 1 + i, hoard.base[2]];
    const copy = makeCopy();
    const ad = makeAd();
    world.add(copy, ad);

    return {
      m,
      bubble: withBlob(makeBubble("oldBubble", "paper"), 0.9),
      copy,
      ad,
      slot,
    };
  });

  const qops = qopMessages.map((m) => {
    const heart = makeHeart();
    world.add(heart);

    return { m, bubble: withBlob(makeBubble("paper", "qop"), 0.9), heart };
  });

  const question = makeQuestion();
  world.add(question);

  const posePeople = (t: number) => {
    for (const who of everyone) {
      const { at, facing, walk } = spotOf(who, t);

      const startled = oldMessages.some(
        (m) => m.to === who && inside(t, m.arrive, m.arrive + AD_TIME)
      );

      const person = cast[who];
      person.pose({ walk, typing: isTyping(who, t), startled });
      person.root.rotation.y = (facing * Math.PI) / 2;
      place(person.root, [at[0], at[1] + hopOf(who, t), at[2]]);
    }
  };

  /** The usual apps: up to the eye, a copy kept, down to the friend, an ad. Returns what the eye watches. */
  const playOld = (t: number) => {
    let watching: Vec3 | null = null;

    for (const { m, bubble, copy, ad, slot } of olds) {
      const sender = spotOf(m.from, t);
      const receiver = spotOf(m.to, t);

      const p = inside(t, m.send, m.arrive)
        ? oldPath(m, t, phoneOf(sender.at, sender.facing), above(receiver.at))
        : null;

      show(bubble, p);
      watching ??= p;

      // The copy drops from the eye onto the hoard, then gets pulled inside.
      const dropAt = m.read + 0.15;
      copy.visible = inside(t, dropAt, ABSORB[1]);

      if (copy.visible) {
        const fall = progress(t, dropAt, dropAt + 0.45);
        const c = fall < 1 ? arc(copyFrom, slot, fall, 0.8) : slot;
        place(copy, [
          c[0],
          c[1],
          c[2] - 1.2 * smooth(progress(t, ABSORB[0], ABSORB[1])),
        ]);

        if (fall < 1) {
          watching ??= c;
        }
      }

      ad.visible = inside(t, m.arrive, m.arrive + AD_TIME);

      if (ad.visible) {
        const pop = t - m.arrive < 0.1 ? -0.5 : 0;
        place(ad, [receiver.at[0], 6.5 + pop, receiver.at[2] + 0.5]);
      }
    }

    return watching;
  };

  /** qop: straight across, a heart on arrival. Returns a message in flight, if any. */
  const playQop = (t: number) => {
    let flying: Vec3 | null = null;

    for (const { m, bubble, heart } of qops) {
      const sender = spotOf(m.from, t);
      const receiver = spotOf(m.to, t);

      const p = inside(t, m.send, m.arrive)
        ? arc(
            phoneOf(sender.at, sender.facing),
            above(receiver.at),
            smooth(progress(t, m.send, m.arrive)),
            2.5
          )
        : null;

      show(bubble, p);
      flying ??= p;

      heart.visible = inside(t, m.arrive, m.arrive + 0.8);

      if (heart.visible) {
        place(heart, [
          receiver.at[0],
          6.5 + Math.floor((t - m.arrive) * 4) * 0.5,
          receiver.at[2],
        ]);
      }
    }

    return flying;
  };

  /** The eye follows old messages and squints at qop ones it can't read; the street camera scans. */
  const watch = (t: number, watching: Vec3 | null, glance: Vec3 | null) => {
    const puzzled =
      watching === null &&
      qopMessages.some((m) => inside(t, m.send + 0.3, m.send + PUZZLED_TIME));

    question.visible = puzzled;

    if (puzzled) {
      const bob = (Math.floor(t * 4) % 2) * 0.5;
      place(question, [
        tower.cell[0] + 1.5,
        tower.height + 3.5 + bob,
        tower.cell[1] + 1.5,
      ]);
    }

    const idle = Math.floor(t / 1.25) % 2 === 0 ? people.L1.at : people.L2.at;
    const look = watching ?? glance ?? [idle[0], 4, idle[2]];
    place(eye.pupil, [
      tower.eye[0] - 0.5 + step(look[0] - tower.eye[0]),
      tower.eye[1] - 0.5 + step(look[1] - tower.eye[1]),
      tower.eye[2] + 0.9,
    ]);

    // The street camera follows the same idle rhythm, in eighth turns.
    const [cx, cz] = cctv.cell;

    const turn = Math.round(
      Math.atan2(idle[0] - cx, idle[2] - cz) / (Math.PI / 4)
    );

    street.head.rotation.y = (turn * Math.PI) / 4;
    street.rec.visible = Math.floor(t * 2) % 2 === 1;
    eye.light.visible = !street.rec.visible;
  };

  const frame = (t: number) => {
    ground.tick(t);
    posePeople(t);
    const watching = playOld(t);
    const glance = playQop(t);
    watch(t, watching, glance);
  };

  return { scene, camera, frame };
};
