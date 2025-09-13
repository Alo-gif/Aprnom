const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" }});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public'));

let players = {};    // socketId -> player
let bullets = {};    // bulletId -> bullet
let pickups = {};    // pickupId -> pickup

// Utility
const rand = (min,max) => Math.floor(Math.random()*(max-min+1))+min;
const createPickup = (id) => ({
  id,
  x: rand(100, 1400),
  y: rand(100, 800),
  type: 'health',
  amount: 25,
  taken: false
});

// seed pickups
for (let i = 0; i < 12; i++) {
  const id = 'p' + i;
  pickups[id] = createPickup(id);
}

let bulletCounter = 0;

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // create player
  players[socket.id] = {
    id: socket.id,
    x: rand(200, 1200),
    y: rand(200, 600),
    dir: 0,
    hp: 100,
    name: `Player_${socket.id.slice(0,4)}`,
    inventory: { medkit: 0, ammo: 30 },
    alive: true,
    speed: 200
  };

  // send initial world + your id
  socket.emit('init', { id: socket.id, players, pickups });

  // notify others
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // handle player updates (movement, rotation)
  socket.on('playerInput', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    // data: {x, y, dir, inputs}
    p.x = data.x;
    p.y = data.y;
    p.dir = data.dir;
    // inventory self-managed? only server-authoritative changes (like pickup) will be applied server-side
  });

  // handle shooting: client asks to shoot; server spawns bullet authoritative
  socket.on('shoot', (payload) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    // basic ammo check
    if (p.inventory.ammo <= 0) return;
    p.inventory.ammo -= 1;

    const bId = 'b' + (++bulletCounter);
    const speed = 600;
    bullets[bId] = {
      id: bId,
      owner: socket.id,
      x: payload.x,
      y: payload.y,
      vx: Math.cos(payload.angle) * speed,
      vy: Math.sin(payload.angle) * speed,
      life: 2000 // ms
    };

    // broadcast bullet spawn
    io.emit('bulletSpawn', bullets[bId]);
  });

  // pick up
  socket.on('pickup', (pickupId) => {
    const p = players[socket.id];
    const pick = pickups[pickupId];
    if (!p || !pick || pick.taken || !p.alive) return;
    // simple proximity check skipped here for speed; trust client but server ensures not already taken
    pick.taken = true;
    // apply effect
    if (pick.type === 'health') {
      p.hp = Math.min(100, p.hp + pick.amount);
    }
    p.inventory.medkit += 1;
    io.emit('pickupTaken', { pickupId, by: socket.id, player: { id: socket.id, hp: p.hp, inventory: p.inventory }});
  });

  socket.on('useMedkit', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (p.inventory.medkit > 0) {
      p.inventory.medkit -= 1;
      p.hp = Math.min(100, p.hp + 40);
      io.emit('playerUpdate', p);
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// server tick to update bullets & detect hits
setInterval(() => {
  const now = Date.now();
  // update bullets positions
  for (const id in bullets) {
    const b = bullets[id];
    if (!b) continue;
    // move
    b.x += b.vx * (1/60);
    b.y += b.vy * (1/60);
    b.life -= 1000/60;
    // check collisions with players
    for (const pid in players) {
      const p = players[pid];
      if (!p || !p.alive) continue;
      if (pid === b.owner) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const dist2 = dx*dx + dy*dy;
      if (dist2 < (20*20)) {
        // hit
        p.hp -= 20;
        if (p.hp <= 0) {
          p.alive = false;
          p.hp = 0;
          io.emit('playerDied', { id: p.id, by: b.owner });
        } else {
          io.emit('playerHit', { id: p.id, hp: p.hp, by: b.owner });
        }
        delete bullets[id];
        break;
      }
    }
    if (b && b.life <= 0) {
      delete bullets[id];
    }
  }

  // Periodic world broadcast (players + bullets)
  io.emit('worldState', { players, bullets, pickups });
}, 1000/20); // 20 ticks/sec

http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
