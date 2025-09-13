const socket = io();

let myId = null;
let players = {};
let bullets = {};
let pickups = {};

const config = {
  type: Phaser.AUTO,
  width: 1400,
  height: 900,
  parent: 'game-container',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: {
    preload: preload,
    create: create,
    update: update
  }
};

const game = new Phaser.Game(config);

let playerSpriteMap = {}; // id -> sprite
let bulletMap = {};
let pickupMap = {};
let cursors;
let pointer;
let localPlayer = { x: 200, y: 200, dir: 0, speed: 200 };

function preload() {
  this.load.image('player', 'assets/player.png');
  this.load.image('bullet', 'assets/bullet.png');
  this.load.image('pickup', 'assets/pickup.png');
  this.load.image('map', 'assets/map.png');
}

function create() {
  const scene = this;
  this.add.tileSprite(700, 450, 1400, 900, 'map');

  cursors = this.input.keyboard.createCursorKeys();
  pointer = this.input.activePointer;

  // local representation
  scene.input.on('pointerdown', (p) => {
    // shoot: send shoot event to server with current pos and angle
    const angle = Phaser.Math.Angle.Between(localPlayer.x, localPlayer.y, p.worldX, p.worldY);
    socket.emit('shoot', { x: localPlayer.x, y: localPlayer.y, angle });
  });

  // use medkit button
  document.getElementById('useMed').addEventListener('click', ()=> {
    socket.emit('useMedkit');
  });

  socket.on('init', (data) => {
    myId = data.id;
    players = data.players;
    pickups = data.pickups;
    // create sprites for players
    for (const id in players) makeOrUpdatePlayer(scene, players[id]);
    for (const pid in pickups) makeOrUpdatePickup(scene, pickups[pid]);
    document.getElementById('playerName').textContent = players[myId].name;
    updateUI();
  });

  socket.on('playerJoined', (p) => {
    players[p.id] = p;
    makeOrUpdatePlayer(scene, p);
  });

  socket.on('playerLeft', (id) => {
    if (playerSpriteMap[id]) {
      playerSpriteMap[id].destroy();
      delete playerSpriteMap[id];
    }
    delete players[id];
  });

  socket.on('bulletSpawn', (b) => {
    bullets[b.id] = b;
    const s = scene.physics.add.image(b.x, b.y, 'bullet').setDepth(2);
    s.setDisplaySize(8,8);
    bulletMap[b.id] = s;
  });

  socket.on('pickupTaken', (info) => {
    // remove pickup sprite
    const id = info.pickupId;
    if (pickupMap[id]) {
      pickupMap[id].destroy();
      delete pickupMap[id];
    }
    // update player UI if it's me
    if (info.player && info.player.id === myId) {
      updateLocalFromServer(info.player);
    }
  });

  socket.on('playerHit', (info) => {
    if (players[info.id]) players[info.id].hp = info.hp;
    if (info.id === myId) updateUI();
  });

  socket.on('playerDied', (info) => {
    if (playerSpriteMap[info.id]) {
      playerSpriteMap[info.id].setTint(0x555555);
    }
  });

  socket.on('playerUpdate', (p) => {
    players[p.id] = p;
    makeOrUpdatePlayer(scene, p);
    if (p.id === myId) updateLocalFromServer(p);
  });

  socket.on('worldState', (state) => {
    players = state.players;
    bullets = state.bullets;
    pickups = state.pickups;
    // sync players
    for (const id in players) makeOrUpdatePlayer(scene, players[id]);
    // sync bullets positions
    for (const id in bullets) {
      const b = bullets[id];
      if (!bulletMap[id]) {
        const s = scene.physics.add.image(b.x, b.y, 'bullet').setDepth(2);
        s.setDisplaySize(8,8);
        bulletMap[id] = s;
      } else {
        bulletMap[id].x = b.x;
        bulletMap[id].y = b.y;
      }
    }
    // remove bullets not present
    for (const id in bulletMap) {
      if (!bullets[id]) {
        bulletMap[id].destroy();
        delete bulletMap[id];
      }
    }
    // pickups
    for (const pid in pickups) {
      const p = pickups[pid];
      if (!p.taken) makeOrUpdatePickup(scene, p);
      else {
        if (pickupMap[pid]) {
          pickupMap[pid].destroy();
          delete pickupMap[pid];
        }
      }
    }
  });
}

function update(time, delta) {
  const scene = this;
  if (!players || !myId) return;

  // local movement input
  let vx = 0, vy = 0;
  const speed = 200;
  if (cursors.left.isDown) vx = -1;
  else if (cursors.right.isDown) vx = 1;
  if (cursors.up.isDown) vy = -1;
  else if (cursors.down.isDown) vy = 1;

  // normalize diagonal
  if (vx !== 0 && vy !== 0) {
    vx *= Math.SQRT1_2;
    vy *= Math.SQRT1_2;
  }

  localPlayer.x += vx * speed * (delta/1000);
  localPlayer.y += vy * speed * (delta/1000);

  // clamp to world
  localPlayer.x = Phaser.Math.Clamp(localPlayer.x, 20, config.width-20);
  localPlayer.y = Phaser.Math.Clamp(localPlayer.y, 20, config.height-20);

  // rotation toward pointer
  const angle = Phaser.Math.Angle.Between(localPlayer.x, localPlayer.y, pointer.worldX, pointer.worldY);
  localPlayer.dir = angle;

  // send input (throttle to 20/sec)
  if (!this._lastSent || time - this._lastSent > 50) {
    socket.emit('playerInput', { x: localPlayer.x, y: localPlayer.y, dir: localPlayer.dir });
    this._lastSent = time;
  }

  // update local sprite for me
  if (playerSpriteMap[myId]) {
    playerSpriteMap[myId].x = localPlayer.x;
    playerSpriteMap[myId].y = localPlayer.y;
    playerSpriteMap[myId].rotation = localPlayer.dir;
  }

  // check overlap with pickups client-side and request pickup (server also checks)
  for (const pid in pickupMap) {
    const s = pickupMap[pid];
    const dx = s.x - localPlayer.x;
    const dy = s.y - localPlayer.y;
    if (dx*dx + dy*dy < 26*26) {
      socket.emit('pickup', pid);
    }
  }

  // update other sprites positions from authoritative data
  for (const id in players) {
    if (id === myId) continue;
    const p = players[id];
    if (!p) continue;
    if (!playerSpriteMap[id]) continue;
    // simple interpolation towards server pos
    playerSpriteMap[id].x += (p.x - playerSpriteMap[id].x) * 0.2;
    playerSpriteMap[id].y += (p.y - playerSpriteMap[id].y) * 0.2;
    playerSpriteMap[id].rotation = p.dir;
  }

  // update bullets visuals
  for (const bid in bulletMap) {
    const bSprite = bulletMap[bid];
    if (bullets[bid]) {
      bSprite.x = bullets[bid].x;
      bSprite.y = bullets[bid].y;
    }
  }
}

function makeOrUpdatePlayer(scene, p) {
  if (!p) return;
  if (!playerSpriteMap[p.id]) {
    const s = scene.add.sprite(p.x, p.y, 'player').setDepth(1);
    s.setDisplaySize(40, 40);
    s.rotation = p.dir || 0;
    playerSpriteMap[p.id] = s;
  } else {
    playerSpriteMap[p.id].x = p.x;
    playerSpriteMap[p.id].y = p.y;
    playerSpriteMap[p.id].rotation = p.dir || 0;
  }
  // if it's me, update local UI
  if (p.id === myId) {
    updateLocalFromServer(p);
  }
}

function makeOrUpdatePickup(scene, p) {
  if (!p) return;
  if (pickupMap[p.id]) {
    pickupMap[p.id].x = p.x; pickupMap[p.id].y = p.y;
  } else {
    const s = scene.add.image(p.x, p.y, 'pickup').setDepth(0);
    s.setDisplaySize(28,28);
    pickupMap[p.id] = s;
  }
}

function updateLocalFromServer(p) {
  localPlayer.x = p.x;
  localPlayer.y = p.y;
  localPlayer.dir = p.dir;
  document.getElementById('hpVal').textContent = p.hp;
  document.getElementById('ammoVal').textContent = p.inventory.ammo;
  document.getElementById('medVal').textContent = p.inventory.medkit;
}

function updateUI() {
  if (!players || !myId || !players[myId]) return;
  updateLocalFromServer(players[myId]);
                      }
