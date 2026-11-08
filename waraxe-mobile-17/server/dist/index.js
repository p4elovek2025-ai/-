import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret)
    throw new Error('JWT_SECRET is required');
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '16kb' }));
function sign(userId) {
    return jwt.sign({ sub: userId }, jwtSecret, { expiresIn: '7d' });
}
function auth(req, res, next) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token)
        return res.status(401).json({ error: 'Требуется авторизация' });
    try {
        const payload = jwt.verify(token, jwtSecret);
        if (typeof payload.sub !== 'string')
            throw new Error('Invalid subject');
        req.userId = payload.sub;
        next();
    }
    catch {
        return res.status(401).json({ error: 'Сессия недействительна' });
    }
}
async function getCharacter(userId) {
    return prisma.character.findUnique({
        where: { userId },
        include: { items: true, quests: true }
    });
}
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'waraxe-api' }));
const classCatalog = {
    warrior: { name: 'Воин', description: 'Крепкая защита и мощные удары', attack: 0, defense: 12, hp: 120 },
    mage: { name: 'Маг', description: 'Высокая сила магического урона', attack: 18, defense: 0, hp: 0 },
    ranger: { name: 'Лучник', description: 'Точные и быстрые атаки', attack: 10, defense: 5, hp: 40 }
};
app.get('/api/progression', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    return res.json({ character, classes: classCatalog, nextLevelExp: character.level * 100 });
});
app.post('/api/progression/class', auth, async (req, res) => {
    const parsed = z.object({ classCode: z.enum(['warrior', 'mage', 'ranger']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неизвестный класс' });
    const current = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!current)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (current.level > 1 || current.classChosen)
        return res.status(409).json({ error: 'Класс можно выбрать только один раз на первом уровне' });
    const updated = await prisma.character.update({ where: { id: current.id }, data: { classCode: parsed.data.classCode, classChosen: true } });
    return res.json({ character: updated, message: 'Класс выбран' });
});
app.post('/api/progression/skill', auth, async (req, res) => {
    const parsed = z.object({ skill: z.enum(['attack', 'defense', 'vitality']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неизвестный навык' });
    const c = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!c)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (c.skillPoints < 1)
        return res.status(409).json({ error: 'Нет свободных очков навыков' });
    const field = parsed.data.skill === 'attack' ? 'skillAttack' : parsed.data.skill === 'defense' ? 'skillDefense' : 'skillVitality';
    const updated = await prisma.character.update({ where: { id: c.id }, data: { skillPoints: { decrement: 1 }, [field]: { increment: 1 } } });
    return res.json({ character: updated });
});
app.post('/api/auth/register', async (req, res) => {
    const schema = z.object({
        email: z.string().email().max(160),
        username: z.string().trim().min(3).max(20).regex(/^[\p{L}\p{N}_-]+$/u),
        password: z.string().min(8).max(72)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Проверь email, имя (3–20 символов) и пароль (от 8 символов)' });
    const { email, username, password } = parsed.data;
    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await prisma.user.create({
            data: {
                email: email.toLowerCase(),
                username,
                passwordHash,
                character: {
                    create: {
                        items: { create: [
                                { code: 'minor_potion', quantity: 3 }, { code: 'rusty_sword', quantity: 1 },
                                { code: 'cloth_hood', quantity: 1 }, { code: 'traveler_vest', quantity: 1 },
                                { code: 'worn_gloves', quantity: 1 }, { code: 'leather_boots', quantity: 1 },
                                { code: 'copper_amulet', quantity: 1 }
                            ] },
                        quests: { create: [{ questCode: 'first_hunt' }] }
                    }
                }
            },
            select: { id: true, username: true }
        });
        return res.status(201).json({ token: sign(user.id), user });
    }
    catch (error) {
        if (error?.code === 'P2002')
            return res.status(409).json({ error: 'Email или имя уже заняты' });
        console.error(error);
        return res.status(500).json({ error: 'Не удалось создать аккаунт' });
    }
});
app.post('/api/auth/login', async (req, res) => {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные входа' });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
        return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    return res.json({ token: sign(user.id), user: { id: user.id, username: user.username } });
});
app.get('/api/me', auth, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, username: true, email: true, createdAt: true }
    });
    if (!user)
        return res.status(404).json({ error: 'Игрок не найден' });
    const character = await getCharacter(user.id);
    return res.json({ user, character });
});
const collectionCatalog = {
    pets: [
        { code: 'wolf_cub', name: 'Волчонок', bonus: '+5% к атаке', attackBonus: 5, art: '🐺' },
        { code: 'ember_fox', name: 'Пепельная лиса', bonus: '+5% к золоту', attackBonus: 0, art: '🦊' },
        { code: 'stone_turtle', name: 'Каменная черепаха', bonus: '+5% к защите', attackBonus: 0, art: '🐢' }
    ],
    runes: [
        { code: 'power_rune', name: 'Руна мощи', bonus: '+10 к атаке', art: '🔴' },
        { code: 'guard_rune', name: 'Руна стража', bonus: '+10 к защите', art: '🔵' },
        { code: 'vital_rune', name: 'Руна жизни', bonus: '+100 к здоровью', art: '🟢' }
    ],
    artifacts: [
        { code: 'ember_relic', name: 'Реликвия пепла', bonus: '+2% к наградам', art: '🔥' },
        { code: 'moon_relic', name: 'Лунный осколок', bonus: '+2% к опыту', art: '🌙' },
        { code: 'iron_relic', name: 'Печать железа', bonus: '+5 к защите', art: '⚙️' }
    ]
};
app.get('/api/collection', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    return res.json({
        equipped: { pet: character.petCode, rune: character.runeCode, artifact: character.artifactCode },
        catalog: collectionCatalog
    });
});
app.post('/api/collection/equip', auth, async (req, res) => {
    const parsed = z.object({
        slot: z.enum(['pet', 'rune', 'artifact']),
        code: z.string().min(1).max(40)
    }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректный предмет' });
    const { slot, code } = parsed.data;
    const list = slot === 'pet' ? collectionCatalog.pets : slot === 'rune' ? collectionCatalog.runes : collectionCatalog.artifacts;
    if (!list.some(item => item.code === code))
        return res.status(400).json({ error: 'Предмет не найден' });
    const character = await prisma.character.update({
        where: { userId: req.userId },
        data: slot === 'pet' ? { petCode: code } : slot === 'rune' ? { runeCode: code } : { artifactCode: code }
    });
    return res.json({
        equipped: { pet: character.petCode, rune: character.runeCode, artifact: character.artifactCode },
        message: 'Экипировка обновлена'
    });
});
const gearCatalog = [
    { code: 'rusty_sword', name: 'Ржавый меч', slot: 'weapon', art: '🗡️', rarity: 'common', attack: 12, defense: 0, level: 1 },
    { code: 'ember_blade', name: 'Клинок пепла', slot: 'weapon', art: '🔥', rarity: 'epic', attack: 65, defense: 0, level: 5 },
    { code: 'cloth_hood', name: 'Тканевый капюшон', slot: 'helmet', art: '🪖', rarity: 'common', attack: 0, defense: 5, level: 1 },
    { code: 'iron_helm', name: 'Железный шлем', slot: 'helmet', art: '⛑️', rarity: 'rare', attack: 0, defense: 22, level: 3 },
    { code: 'traveler_vest', name: 'Жилет путника', slot: 'armor', art: '🥋', rarity: 'common', attack: 0, defense: 10, level: 1 },
    { code: 'ash_plate', name: 'Доспех пепла', slot: 'armor', art: '🛡️', rarity: 'epic', attack: 0, defense: 55, level: 5 },
    { code: 'worn_gloves', name: 'Поношенные перчатки', slot: 'gloves', art: '🥊', rarity: 'common', attack: 2, defense: 2, level: 1 },
    { code: 'iron_gauntlets', name: 'Железные рукавицы', slot: 'gloves', art: '🧤', rarity: 'rare', attack: 8, defense: 12, level: 3 },
    { code: 'leather_boots', name: 'Кожаные сапоги', slot: 'boots', art: '🥾', rarity: 'common', attack: 0, defense: 4, level: 1 },
    { code: 'swift_boots', name: 'Сапоги стремительности', slot: 'boots', art: '👢', rarity: 'rare', attack: 5, defense: 10, level: 3 },
    { code: 'copper_amulet', name: 'Медный амулет', slot: 'amulet', art: '📿', rarity: 'common', attack: 4, defense: 4, level: 1 },
    { code: 'dragon_heart', name: 'Сердце дракона', slot: 'amulet', art: '❤️‍🔥', rarity: 'epic', attack: 25, defense: 25, level: 5 }
];
const slotField = {
    weapon: 'weaponCode', helmet: 'helmetCode', armor: 'armorCode',
    gloves: 'glovesCode', boots: 'bootsCode', amulet: 'amuletCode'
};
async function getCombatStats(tx, character) {
    const codes = Object.values(slotField).map((field) => character[field]).filter(Boolean);
    const items = await tx.inventoryItem.findMany({ where: { characterId: character.id, code: { in: codes } } });
    const archetype = classCatalog[character.classCode] || classCatalog.warrior;
    let attack = character.attack + archetype.attack + (character.skillAttack || 0) * 8;
    let defense = character.defense + archetype.defense + (character.skillDefense || 0) * 6;
    let maxHp = character.maxHp + archetype.hp + (character.skillVitality || 0) * 50;
    for (const code of codes) {
        const gear = gearCatalog.find((g) => g.code === code);
        const item = items.find((i) => i.code === code);
        if (!gear)
            continue;
        const level = item?.enhancement || 0;
        attack += gear.attack + level * 12;
        defense += gear.defense + level * 4;
        maxHp += level * 20;
    }
    const armorSlots = ['helmetCode', 'armorCode', 'glovesCode', 'bootsCode'];
    const rareCount = armorSlots.filter(field => {
        const gear = gearCatalog.find((g) => g.code === character[field]);
        return gear && gear.rarity !== 'common';
    }).length;
    if (rareCount >= 2) {
        defense += 15;
        maxHp += 100;
    }
    if (rareCount >= 4) {
        attack += 25;
        defense += 25;
        maxHp += 250;
    }
    return { attack, defense, maxHp };
}
const activeSkillCatalog = {
    warrior: {
        power_strike: { name: 'Сокрушительный удар', description: 'Мощная атака ×2.0', multiplier: 2 },
        shield_bash: { name: 'Удар щитом', description: 'Атака ×1.35 и восстановление 8% здоровья', multiplier: 1.35, heal: 0.08 }
    },
    mage: {
        fireball: { name: 'Огненный шар', description: 'Магический урон ×2.4', multiplier: 2.4 },
        arcane_surge: { name: 'Тайный всплеск', description: 'Урон ×1.6 и восстановление 12% здоровья', multiplier: 1.6, heal: 0.12 }
    },
    ranger: {
        aimed_shot: { name: 'Меткий выстрел', description: 'Точный урон ×2.1', multiplier: 2.1 },
        quick_volley: { name: 'Быстрый залп', description: 'Серия атак ×1.5', multiplier: 1.5 }
    }
};
app.get('/api/combat/skills', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const classCode = character.classCode in activeSkillCatalog ? character.classCode : 'warrior';
    return res.json({ classCode, skills: Object.entries(activeSkillCatalog[classCode]).map(([code, skill]) => ({ code, ...skill })) });
});
app.post('/api/combat/cast', auth, async (req, res) => {
    const parsed = z.object({
        skillCode: z.string().min(2).max(40),
        enemy: z.enum(['griffin', 'golem', 'abyss']).default('griffin')
    }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректный навык или противник' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (character.hp <= 0)
        return res.status(409).json({ error: 'Сначала восстанови здоровье' });
    const classCode = character.classCode in activeSkillCatalog ? character.classCode : 'warrior';
    const skill = activeSkillCatalog[classCode][parsed.data.skillCode];
    if (!skill)
        return res.status(403).json({ error: 'Этот навык недоступен выбранному классу' });
    const stats = await getCombatStats(prisma, character);
    const enemy = enemyCatalog[parsed.data.enemy];
    if (character.level < enemy.level)
        return res.status(403).json({ error: `Нужен уровень ${enemy.level}` });
    const damage = Math.max(1, Math.floor(stats.attack * skill.multiplier));
    const heal = skill.heal ? Math.floor(stats.maxHp * skill.heal) : 0;
    const updated = await prisma.character.update({
        where: { id: character.id },
        data: { hp: Math.min(stats.maxHp, character.hp + heal) }
    });
    return res.json({ skill: skill.name, description: skill.description, damage, heal, character: updated, enemy: parsed.data.enemy });
});
app.get('/api/equipment', auth, async (req, res) => {
    const character = await prisma.character.findUnique({
        where: { userId: req.userId }, include: { items: true }
    });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const equippedCodes = Object.fromEntries(Object.entries(slotField).map(([slot, field]) => [slot, character[field]]));
    const owned = character.items.map(item => ({
        ...item, ...(gearCatalog.find(g => g.code === item.code) || { name: item.code, slot: 'material', art: '📦', attack: 0, defense: 0 })
    }));
    const equipped = Object.entries(equippedCodes).map(([slot, code]) => gearCatalog.find(g => g.code === code)).filter(Boolean);
    const stats = await getCombatStats(prisma, character);
    return res.json({ equipped, equippedCodes, owned, catalog: gearCatalog, stats });
});
app.post('/api/equipment/equip', auth, async (req, res) => {
    const parsed = z.object({ itemCode: z.string().min(2).max(40) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери предмет' });
    const gear = gearCatalog.find(g => g.code === parsed.data.itemCode);
    if (!gear)
        return res.status(404).json({ error: 'Такого предмета нет' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId }, include: { items: true } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const owned = character.items.find(i => i.code === gear.code && i.quantity > 0);
    const currentlyEquipped = character[slotField[gear.slot]];
    if (!owned && currentlyEquipped !== gear.code)
        return res.status(409).json({ error: 'Предмет отсутствует в инвентаре' });
    if (character.level < gear.level)
        return res.status(403).json({ error: `Нужен уровень ${gear.level}` });
    const updated = await prisma.character.update({
        where: { id: character.id },
        data: { [slotField[gear.slot]]: gear.code }
    });
    return res.json({ equippedCode: gear.code, character: updated, message: `${gear.name} экипирован` });
});
const enemyCatalog = {
    griffin: { name: 'Грифон', level: 1, hp: 360, attack: 45, gold: 90, exp: 35 },
    golem: { name: 'Пепельный голем', level: 3, hp: 620, attack: 70, gold: 150, exp: 60 },
    abyss: { name: 'Демон бездны', level: 5, hp: 950, attack: 105, gold: 260, exp: 100 }
};
app.post('/api/game/hunt', auth, async (req, res) => {
    const parsed = z.object({ enemy: z.enum(['griffin', 'golem', 'abyss']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неизвестный противник' });
    const enemy = enemyCatalog[parsed.data.enemy];
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (character.level < enemy.level)
        return res.status(403).json({ error: `Нужен уровень ${enemy.level}` });
    if (character.hp <= 0)
        return res.status(409).json({ error: 'Персонаж без сознания. Восстанови здоровье.' });
    const combatStats = await getCombatStats(prisma, character);
    const playerDamage = Math.max(1, combatStats.attack + Math.floor(Math.random() * 25));
    const enemyDamage = Math.max(0, enemy.attack - Math.floor(combatStats.defense * 0.35));
    const won = playerDamage * 4 >= enemy.hp;
    const updated = await prisma.$transaction(async (tx) => {
        const hp = Math.max(0, character.hp - (won ? enemyDamage : enemyDamage * 2));
        const exp = character.experience + (won ? enemy.exp : 0);
        const nextLevel = character.level + (exp >= character.level * 100 ? 1 : 0);
        const remainingExp = nextLevel > character.level ? exp - character.level * 100 : exp;
        const saved = await tx.character.update({
            where: { id: character.id },
            data: {
                hp,
                gold: { increment: won ? enemy.gold : 0 },
                experience: remainingExp,
                level: nextLevel
            }
        });
        if (won) {
            await tx.inventoryItem.upsert({
                where: { characterId_code: { characterId: character.id, code: 'minor_potion' } },
                create: { characterId: character.id, code: 'minor_potion', quantity: 1, rarity: 'common' },
                update: { quantity: { increment: 1 } }
            });
            if (Math.random() < 0.35) {
                await tx.inventoryItem.upsert({
                    where: { characterId_code: { characterId: character.id, code: 'ember_shard' } },
                    create: { characterId: character.id, code: 'ember_shard', quantity: 1, rarity: 'rare' },
                    update: { quantity: { increment: 1 } }
                });
            }
            const gearDrop = Math.random() < 0.08 ? (parsed.data.enemy === 'abyss' ? 'ember_blade' : 'iron_helm') : null;
            if (gearDrop) {
                await tx.inventoryItem.upsert({
                    where: { characterId_code: { characterId: character.id, code: gearDrop } },
                    create: { characterId: character.id, code: gearDrop, quantity: 1, rarity: gearDrop === 'ember_blade' ? 'epic' : 'rare' },
                    update: { quantity: { increment: 1 } }
                });
            }
            await tx.questProgress.updateMany({
                where: { characterId: character.id, questCode: 'first_hunt' },
                data: { progress: 1 }
            });
        }
        return tx.character.findUniqueOrThrow({
            where: { id: saved.id },
            include: { items: true }
        });
    });
    return res.json({
        won,
        enemy: enemy.name,
        playerDamage,
        enemyDamage,
        reward: won ? { gold: enemy.gold, experience: enemy.exp, item: 'minor_potion', rareDropChance: 35, gearDropChance: 8 } : null,
        character: updated
    });
});
app.post('/api/game/claim-quest', auth, async (req, res) => {
    const parsed = z.object({ questCode: z.string().min(1).max(40) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректное задание' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const quest = await prisma.questProgress.findUnique({
        where: { characterId_questCode: { characterId: character.id, questCode: parsed.data.questCode } }
    });
    if (!quest)
        return res.status(404).json({ error: 'Задание не найдено' });
    if (quest.claimed)
        return res.status(409).json({ error: 'Награда уже получена' });
    if (quest.progress < 1)
        return res.status(409).json({ error: 'Сначала выполни задание в охоте' });
    const [claimed, updated] = await prisma.$transaction([
        prisma.questProgress.update({ where: { id: quest.id }, data: { claimed: true } }),
        prisma.character.update({ where: { id: character.id }, data: { gold: { increment: 250 } } })
    ]);
    return res.json({ quest: claimed, character: updated, reward: { gold: 250 } });
});
app.post('/api/game/upgrade', auth, async (req, res) => {
    const parsed = z.object({ itemCode: z.enum(['rusty_sword', 'ember_blade']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери оружие для улучшения' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const item = await prisma.inventoryItem.findUnique({
        where: { characterId_code: { characterId: character.id, code: parsed.data.itemCode } }
    });
    if (!item || item.quantity < 1)
        return res.status(404).json({ error: 'Такого оружия нет в инвентаре' });
    const shard = await prisma.inventoryItem.findUnique({
        where: { characterId_code: { characterId: character.id, code: 'ember_shard' } }
    });
    const cost = (item.enhancement + 1) * 500;
    if (character.gold < cost)
        return res.status(409).json({ error: `Нужно ${cost} золота` });
    if (!shard || shard.quantity < 1)
        return res.status(409).json({ error: 'Нужен осколок пепла. Его можно найти в охоте.' });
    if (item.enhancement >= 10)
        return res.status(409).json({ error: 'Достигнут максимальный уровень заточки +10' });
    const result = await prisma.$transaction(async (tx) => {
        const updatedItem = await tx.inventoryItem.update({
            where: { id: item.id }, data: { enhancement: { increment: 1 }, rarity: item.enhancement >= 4 ? 'epic' : item.enhancement >= 2 ? 'rare' : 'uncommon' }
        });
        await tx.inventoryItem.update({ where: { id: shard.id }, data: { quantity: { decrement: 1 } } });
        const updatedCharacter = await tx.character.update({
            where: { id: character.id }, data: { gold: { decrement: cost }, attack: { increment: 12 } }
        });
        return { item: updatedItem, character: updatedCharacter };
    });
    return res.json({ ...result, cost, message: `Улучшение +${result.item.enhancement} успешно` });
});
app.post('/api/game/heal', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const item = await prisma.inventoryItem.findUnique({ where: { characterId_code: { characterId: character.id, code: 'minor_potion' } } });
    if (!item || item.quantity < 1)
        return res.status(409).json({ error: 'Нет зелий здоровья' });
    const [updated] = await prisma.$transaction([
        prisma.character.update({ where: { id: character.id }, data: { hp: character.maxHp } }),
        prisma.inventoryItem.update({ where: { id: item.id }, data: { quantity: { decrement: 1 } } })
    ]);
    return res.json({ character: updated, message: 'Здоровье восстановлено' });
});
// Arena: quick server-authoritative duel against a selected online account.
app.post('/api/arena/duel', auth, async (req, res) => {
    const parsed = z.object({ opponent: z.string().trim().min(3).max(20) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажи имя соперника' });
    const [me, opponent] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.userId }, include: { character: true } }),
        prisma.user.findUnique({ where: { username: parsed.data.opponent }, include: { character: true } })
    ]);
    if (!me?.character || !opponent?.character)
        return res.status(404).json({ error: 'Игрок или персонаж не найден' });
    if (me.id === opponent.id)
        return res.status(400).json({ error: 'Нельзя вызвать самого себя' });
    const [myStats, theirStats] = await Promise.all([getCombatStats(prisma, me.character), getCombatStats(prisma, opponent.character)]);
    const myPower = myStats.attack + Math.floor(myStats.defense / 2) + me.character.level * 10;
    const theirPower = theirStats.attack + Math.floor(theirStats.defense / 2) + opponent.character.level * 10;
    const won = myPower + Math.floor(Math.random() * 100) >= theirPower + Math.floor(Math.random() * 100);
    const reward = won ? 75 : 15;
    const updated = await prisma.character.update({
        where: { id: me.character.id },
        data: { gold: { increment: reward }, experience: { increment: won ? 20 : 5 } }
    });
    return res.json({ won, opponent: opponent.username, reward: { gold: reward, experience: won ? 20 : 5 }, character: updated });
});
app.get('/api/boss', auth, async (_req, res) => {
    const boss = await prisma.worldBoss.upsert({
        where: { id: 'world-ash-dragon' },
        create: { id: 'world-ash-dragon', name: 'Древний дракон пепла', hp: 1000000, maxHp: 1000000 },
        update: {}
    });
    const top = await prisma.bossHit.groupBy({
        by: ['userId', 'username'], where: { bossId: boss.id },
        _sum: { damage: true }, orderBy: { _sum: { damage: 'desc' } }, take: 10
    });
    return res.json({ boss, top });
});
app.post('/api/boss/attack', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const boss = await prisma.worldBoss.upsert({
        where: { id: 'world-ash-dragon' },
        create: { id: 'world-ash-dragon', name: 'Древний дракон пепла', hp: 1000000, maxHp: 1000000 },
        update: {}
    });
    if (boss.hp <= 0)
        return res.status(409).json({ error: 'Босс уже повержен. Ожидай следующего появления.' });
    const stats = await getCombatStats(prisma, character);
    const damage = Math.max(1, stats.attack + Math.floor(Math.random() * Math.max(10, character.level * 8)));
    const result = await prisma.$transaction(async (tx) => {
        const current = await tx.worldBoss.findUniqueOrThrow({ where: { id: boss.id } });
        const actualDamage = Math.min(current.hp, damage);
        const updatedBoss = await tx.worldBoss.update({ where: { id: boss.id }, data: { hp: { decrement: actualDamage } } });
        const user = await tx.user.findUniqueOrThrow({ where: { id: req.userId }, select: { username: true } });
        await tx.bossHit.create({ data: { bossId: boss.id, userId: req.userId, username: user.username, damage: actualDamage } });
        return { updatedBoss, actualDamage };
    });
    return res.json({ boss: result.updatedBoss, damage: result.actualDamage, defeated: result.updatedBoss.hp <= 0 });
});
const DUNGEON_CODE = 'ash_catacombs';
const DUNGEON_PHASES = [
    { name: 'Страж катакомб', hp: 50000, multiplier: 1 },
    { name: 'Пепельный жрец', hp: 85000, multiplier: 1.25 },
    { name: 'Драконья тень', hp: 140000, multiplier: 1.6 }
];
app.get('/api/dungeons/current', auth, async (req, res) => {
    const run = await prisma.dungeonRun.findFirst({
        where: { status: { in: ['forming', 'active'] }, members: { some: { userId: req.userId } } },
        include: { members: { orderBy: { damage: 'desc' } } },
        orderBy: { createdAt: 'desc' }
    });
    return res.json({ run, phases: DUNGEON_PHASES });
});
app.post('/api/dungeons/create', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (character.level < 3)
        return res.status(403).json({ error: 'Для подземелья нужен 3-й уровень' });
    const existing = await prisma.dungeonRun.findFirst({
        where: { status: { in: ['forming', 'active'] }, members: { some: { userId: req.userId } } }
    });
    if (existing)
        return res.status(409).json({ error: 'Ты уже состоишь в походе' });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { username: true } });
    const run = await prisma.dungeonRun.create({
        data: { code: DUNGEON_CODE, phase: 1, bossHp: DUNGEON_PHASES[0].hp, maxBossHp: DUNGEON_PHASES[0].hp, status: 'forming',
            members: { create: { userId: req.userId, username: user.username } } },
        include: { members: true }
    });
    return res.json({ run, phases: DUNGEON_PHASES });
});
app.post('/api/dungeons/join', auth, async (req, res) => {
    const parsed = z.object({ runId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не указан поход' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character || character.level < 3)
        return res.status(403).json({ error: 'Для подземелья нужен 3-й уровень' });
    const current = await prisma.dungeonRun.findFirst({ where: { status: { in: ['forming', 'active'] }, members: { some: { userId: req.userId } } } });
    if (current)
        return res.status(409).json({ error: 'Ты уже состоишь в походе' });
    const run = await prisma.dungeonRun.findUnique({ where: { id: parsed.data.runId }, include: { members: true } });
    if (!run || run.status !== 'forming' || run.members.length >= 4)
        return res.status(409).json({ error: 'Группа уже заполнена или поход начался' });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { username: true } });
    const updated = await prisma.dungeonRun.update({
        where: { id: run.id },
        data: { members: { create: { userId: req.userId, username: user.username } } },
        include: { members: true }
    });
    return res.json({ run: updated, phases: DUNGEON_PHASES });
});
app.get('/api/dungeons/lobby', auth, async (_req, res) => {
    const runs = await prisma.dungeonRun.findMany({
        where: { status: 'forming' }, include: { members: true }, orderBy: { createdAt: 'asc' }, take: 20
    });
    return res.json({ runs, phases: DUNGEON_PHASES });
});
app.post('/api/dungeons/attack', auth, async (req, res) => {
    const parsed = z.object({ runId: z.string().min(1), skillCode: z.string().optional() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректный запрос' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character || character.hp <= 0)
        return res.status(409).json({ error: 'Нужно восстановить здоровье' });
    const run = await prisma.dungeonRun.findUnique({ where: { id: parsed.data.runId }, include: { members: true } });
    if (!run || !['forming', 'active'].includes(run.status) || !run.members.some(m => m.userId === req.userId))
        return res.status(404).json({ error: 'Поход не найден' });
    const stats = await getCombatStats(prisma, character);
    let multiplier = 1;
    if (parsed.data.skillCode) {
        const classSkills = activeSkillCatalog[character.classCode] || activeSkillCatalog.warrior;
        const skill = classSkills[parsed.data.skillCode];
        if (!skill)
            return res.status(403).json({ error: 'Умение недоступно этому классу' });
        multiplier = skill.multiplier;
    }
    const damage = Math.max(1, Math.floor(stats.attack * multiplier * DUNGEON_PHASES[run.phase - 1].multiplier));
    const result = await prisma.$transaction(async (tx) => {
        const current = await tx.dungeonRun.findUniqueOrThrow({ where: { id: run.id } });
        if (current.status === 'completed')
            throw new Error('Поход уже завершён');
        const actualDamage = Math.min(current.bossHp, damage);
        const hpLeft = Math.max(0, current.bossHp - actualDamage);
        const member = await tx.dungeonMember.update({ where: { runId_userId: { runId: run.id, userId: req.userId } }, data: { damage: { increment: actualDamage } } });
        if (hpLeft > 0) {
            const updatedRun = await tx.dungeonRun.update({ where: { id: run.id }, data: { status: 'active', bossHp: hpLeft } });
            return { run: updatedRun, damage: actualDamage, member, phaseChanged: false, completed: false };
        }
        if (current.phase >= DUNGEON_PHASES.length) {
            const updatedRun = await tx.dungeonRun.update({ where: { id: run.id }, data: { status: 'completed', bossHp: 0 } });
            return { run: updatedRun, damage: actualDamage, member, phaseChanged: false, completed: true };
        }
        const nextPhase = current.phase + 1;
        const nextHp = DUNGEON_PHASES[nextPhase - 1].hp;
        const updatedRun = await tx.dungeonRun.update({ where: { id: run.id }, data: { phase: nextPhase, bossHp: nextHp, maxBossHp: nextHp, status: 'active' } });
        return { run: updatedRun, damage: actualDamage, member, phaseChanged: true, completed: false };
    });
    return res.json({ ...result, phaseName: DUNGEON_PHASES[result.run.phase - 1]?.name || 'Завершено' });
});
app.post('/api/dungeons/claim', auth, async (req, res) => {
    const parsed = z.object({ runId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не указан поход' });
    const run = await prisma.dungeonRun.findUnique({ where: { id: parsed.data.runId }, include: { members: true } });
    if (!run || run.status !== 'completed')
        return res.status(409).json({ error: 'Подземелье ещё не завершено' });
    const member = run.members.find(m => m.userId === req.userId);
    if (!member)
        return res.status(403).json({ error: 'Ты не участвовал в этом походе' });
    if (member.claimed)
        return res.status(409).json({ error: 'Награда уже получена' });
    const rewardGold = 800 + Math.floor(member.damage / 100);
    const rewardExp = 250;
    const result = await prisma.$transaction(async (tx) => {
        const claimed = await tx.dungeonMember.updateMany({ where: { runId: run.id, userId: req.userId, claimed: false }, data: { claimed: true } });
        if (!claimed.count)
            throw new Error('Награда уже получена');
        const character = await tx.character.update({ where: { userId: req.userId }, data: { gold: { increment: rewardGold }, experience: { increment: rewardExp } } });
        return character;
    });
    return res.json({ character: result, reward: { gold: rewardGold, experience: rewardExp } });
});
app.get('/api/clans', auth, async (_req, res) => {
    const clans = await prisma.clan.findMany({
        include: { _count: { select: { members: true } } },
        orderBy: [{ level: 'desc' }, { createdAt: 'asc' }], take: 30
    });
    return res.json({ clans });
});
app.post('/api/clans', auth, async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(3).max(24).regex(/^[\p{L}\p{N} _-]+$/u), description: z.string().max(160).default('') }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Название клана: 3–24 символа' });
    const existing = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (existing)
        return res.status(409).json({ error: 'Ты уже состоишь в клане' });
    try {
        const clan = await prisma.clan.create({
            data: { name: parsed.data.name, description: parsed.data.description, members: { create: { userId: req.userId, role: 'leader' } } },
            include: { _count: { select: { members: true } } }
        });
        return res.status(201).json({ clan });
    }
    catch (e) {
        if (e?.code === 'P2002')
            return res.status(409).json({ error: 'Такое название клана уже занято' });
        throw e;
    }
});
app.post('/api/clans/join', auth, async (req, res) => {
    const parsed = z.object({ clanId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери клан' });
    const current = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (current)
        return res.status(409).json({ error: 'Ты уже состоишь в клане' });
    try {
        const member = await prisma.clanMember.create({ data: { clanId: parsed.data.clanId, userId: req.userId } });
        return res.json({ member });
    }
    catch {
        return res.status(404).json({ error: 'Клан не найден' });
    }
});
const TERRITORY_SEEDS = [
    { code: 'north_fort', name: 'Северная крепость', description: 'Укреплённые ворота и древний арсенал' },
    { code: 'ashen_mines', name: 'Пепельные шахты', description: 'Рудники с редкими минералами' },
    { code: 'darkwood', name: 'Мрачный лес', description: 'Лесные тропы и охотничьи угодья' }
];
app.get('/api/clan-wars', auth, async (req, res) => {
    await Promise.all(TERRITORY_SEEDS.map(t => prisma.territory.upsert({ where: { code: t.code }, create: t, update: {} })));
    const [territories, wars, membership] = await Promise.all([
        prisma.territory.findMany({ include: { ownerClan: { select: { id: true, name: true, level: true } } }, orderBy: { name: 'asc' } }),
        prisma.clanWar.findMany({ where: { status: 'active' }, include: { attackerClan: { select: { name: true } }, defenderClan: { select: { name: true } }, territory: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
        prisma.clanMember.findUnique({ where: { userId: req.userId }, include: { clan: true } })
    ]);
    return res.json({ territories, wars, membership });
});
app.post('/api/clan-wars/claim', auth, async (req, res) => {
    const parsed = z.object({ territoryId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери территорию' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member || member.role !== 'leader')
        return res.status(403).json({ error: 'Захватывать нейтральные земли может только глава клана' });
    const result = await prisma.territory.updateMany({ where: { id: parsed.data.territoryId, ownerClanId: null }, data: { ownerClanId: member.clanId, capturedAt: new Date() } });
    if (!result.count)
        return res.status(409).json({ error: 'Территория уже занята' });
    await prisma.clan.update({ where: { id: member.clanId }, data: { level: { increment: 1 } } });
    return res.json({ success: true, message: 'Территория присоединена к клану' });
});
app.post('/api/clan-wars/declare', auth, async (req, res) => {
    const parsed = z.object({ territoryId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери территорию' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId }, include: { clan: true } });
    if (!member)
        return res.status(403).json({ error: 'Сначала вступи в клан' });
    if (member.role !== 'leader')
        return res.status(403).json({ error: 'Объявлять войну может только глава клана' });
    const territory = await prisma.territory.findUnique({ where: { id: parsed.data.territoryId } });
    if (!territory?.ownerClanId)
        return res.status(409).json({ error: 'Эта территория ещё ничья. Её можно будет занять в следующем обновлении.' });
    if (territory.ownerClanId === member.clanId)
        return res.status(409).json({ error: 'Это территория твоего клана' });
    const active = await prisma.clanWar.findFirst({ where: { status: 'active', territoryId: territory.id } });
    if (active)
        return res.status(409).json({ error: 'За эту территорию уже идёт война' });
    const war = await prisma.clanWar.create({ data: { attackerClanId: member.clanId, defenderClanId: territory.ownerClanId, territoryId: territory.id } });
    return res.status(201).json({ war });
});
app.post('/api/clan-wars/strike', auth, async (req, res) => {
    const parsed = z.object({ warId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрана война' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member)
        return res.status(403).json({ error: 'Нужен клан' });
    const war = await prisma.clanWar.findUnique({ where: { id: parsed.data.warId } });
    if (!war || war.status !== 'active' || ![war.attackerClanId, war.defenderClanId].includes(member.clanId))
        return res.status(403).json({ error: 'Ты не участник этой войны' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character || character.hp <= 0)
        return res.status(409).json({ error: 'Восстанови здоровье перед атакой' });
    const stats = await getCombatStats(prisma, character);
    const damage = Math.max(1, Math.floor(stats.attack * (0.8 + Math.random() * 0.4)));
    const attackerSide = member.clanId === war.attackerClanId;
    const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.clanWar.findUniqueOrThrow({ where: { id: war.id } });
        if (current.status !== 'active')
            throw new Error('Война уже завершена');
        const nextScore = (attackerSide ? current.attackerScore : current.defenderScore) + damage;
        const won = nextScore >= 5000;
        const updateData = attackerSide
            ? { attackerScore: { increment: damage }, ...(won ? { status: 'completed', winnerClanId: member.clanId } : {}) }
            : { defenderScore: { increment: damage }, ...(won ? { status: 'completed', winnerClanId: member.clanId } : {}) };
        const updatedWar = await tx.clanWar.update({ where: { id: war.id }, data: updateData });
        if (won) {
            await tx.territory.update({ where: { id: war.territoryId }, data: { ownerClanId: member.clanId, capturedAt: new Date() } });
            await tx.clan.update({ where: { id: member.clanId }, data: { level: { increment: 1 } } });
        }
        return updatedWar;
    });
    return res.json({ war: updated, damage, won: updated.status === 'completed' });
});
app.get('/api/alliances', auth, async (req, res) => {
    const [alliances, membership] = await Promise.all([
        prisma.alliance.findMany({ include: { members: { include: { clan: { select: { id: true, name: true, level: true } } } } }, orderBy: { createdAt: 'desc' }, take: 30 }),
        prisma.clanMember.findUnique({ where: { userId: req.userId }, include: { clan: { include: { allianceMembership: { include: { alliance: true } } } } } })
    ]);
    return res.json({ alliances, membership });
});
app.post('/api/alliances/create', auth, async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(3).max(28) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Название союза: 3–28 символов' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member || member.role !== 'leader')
        return res.status(403).json({ error: 'Создать союз может только глава клана' });
    const current = await prisma.allianceMember.findUnique({ where: { clanId: member.clanId } });
    if (current)
        return res.status(409).json({ error: 'Твой клан уже состоит в союзе' });
    try {
        const alliance = await prisma.alliance.create({ data: { name: parsed.data.name, members: { create: { clanId: member.clanId, role: 'leader' } } }, include: { members: { include: { clan: true } } } });
        return res.status(201).json({ alliance });
    }
    catch (e) {
        if (e?.code === 'P2002')
            return res.status(409).json({ error: 'Такое название союза уже занято или клан уже в союзе' });
        throw e;
    }
});
app.post('/api/alliances/join', auth, async (req, res) => {
    const parsed = z.object({ allianceId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери союз' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member || member.role !== 'leader')
        return res.status(403).json({ error: 'Вступить в союз может только глава клана' });
    try {
        const alliance = await prisma.alliance.findUnique({ where: { id: parsed.data.allianceId } });
        if (!alliance)
            return res.status(404).json({ error: 'Союз не найден' });
        const joined = await prisma.allianceMember.create({ data: { allianceId: alliance.id, clanId: member.clanId } });
        return res.json({ joined });
    }
    catch (e) {
        if (e?.code === 'P2002')
            return res.status(409).json({ error: 'Твой клан уже состоит в союзе' });
        throw e;
    }
});
app.get('/api/sieges', auth, async (_req, res) => {
    const sieges = await prisma.castleSiege.findMany({
        where: { status: 'active' },
        include: { territory: true, attackerClan: { select: { id: true, name: true } }, defenderClan: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' }, take: 20
    });
    return res.json({ sieges });
});
app.post('/api/sieges/declare', auth, async (req, res) => {
    const parsed = z.object({ territoryId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери крепость' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member || member.role !== 'leader')
        return res.status(403).json({ error: 'Осады объявляют главы кланов' });
    const territory = await prisma.territory.findUnique({ where: { id: parsed.data.territoryId } });
    if (!territory?.ownerClanId || territory.ownerClanId === member.clanId)
        return res.status(409).json({ error: 'Можно осадить только чужую занятую территорию' });
    const active = await prisma.castleSiege.findFirst({ where: { territoryId: territory.id, status: 'active' } });
    if (active)
        return res.status(409).json({ error: 'Эта крепость уже осаждается' });
    const siege = await prisma.castleSiege.create({ data: { territoryId: territory.id, attackerClanId: member.clanId, defenderClanId: territory.ownerClanId } });
    return res.status(201).json({ siege });
});
app.post('/api/sieges/engine', auth, async (req, res) => {
    const parsed = z.object({ siegeId: z.string().min(1), engine: z.enum(['ram', 'catapult']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери осадное орудие' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    if (!member)
        return res.status(403).json({ error: 'Нужен клан' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const siege = await prisma.castleSiege.findUnique({ where: { id: parsed.data.siegeId } });
    if (!siege || siege.status !== 'active' || siege.attackerClanId !== member.clanId)
        return res.status(403).json({ error: 'Ты не участвуешь в атакующей стороне осады' });
    const cost = parsed.data.engine === 'ram' ? 150 : 250;
    if (character.gold < cost)
        return res.status(409).json({ error: `Нужно ${cost} золота для орудия` });
    const stats = await getCombatStats(prisma, character);
    const power = Math.max(1, Math.floor(stats.attack * (parsed.data.engine === 'ram' ? 7 : 5)));
    const updated = await prisma.$transaction(async (tx) => {
        await tx.character.update({ where: { userId: req.userId }, data: { gold: { decrement: cost } } });
        const current = await tx.castleSiege.findUniqueOrThrow({ where: { id: siege.id } });
        const gateDamage = Math.min(current.gateHp, power);
        const rest = power - gateDamage;
        const wallDamage = Math.min(current.wallHp, rest);
        const won = gateDamage >= current.gateHp && wallDamage >= current.wallHp;
        const next = await tx.castleSiege.update({ where: { id: siege.id }, data: {
                gateHp: { decrement: gateDamage }, wallHp: { decrement: wallDamage }, attackerScore: { increment: power },
                ...(won ? { status: 'completed', winnerClanId: member.clanId } : {})
            } });
        if (won) {
            await tx.territory.update({ where: { id: siege.territoryId }, data: { ownerClanId: member.clanId, capturedAt: new Date() } });
            await tx.clan.update({ where: { id: member.clanId }, data: { level: { increment: 2 } } });
        }
        return next;
    });
    return res.json({ siege: updated, power, cost, won: updated.status === 'completed' });
});
app.post('/api/sieges/defend', auth, async (req, res) => {
    const parsed = z.object({ siegeId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрана осада' });
    const member = await prisma.clanMember.findUnique({ where: { userId: req.userId } });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!member || !character)
        return res.status(403).json({ error: 'Нужен персонаж в клане' });
    const siege = await prisma.castleSiege.findUnique({ where: { id: parsed.data.siegeId } });
    if (!siege || siege.status !== 'active' || siege.defenderClanId !== member.clanId)
        return res.status(403).json({ error: 'Ты не защищаешь эту крепость' });
    if (character.gold < 100)
        return res.status(409).json({ error: 'Нужно 100 золота на ремонт' });
    const updated = await prisma.$transaction(async (tx) => {
        await tx.character.update({ where: { userId: req.userId }, data: { gold: { decrement: 100 } } });
        return tx.castleSiege.update({ where: { id: siege.id }, data: { gateHp: Math.min(siege.maxGateHp, siege.gateHp + 1000), wallHp: Math.min(siege.maxWallHp, siege.wallHp + 1500), defenderScore: { increment: 1000 } } });
    });
    return res.json({ siege: updated, repaired: true });
});
async function areFriends(a, b) {
    const relation = await prisma.friendship.findFirst({
        where: { status: 'accepted', OR: [{ userAId: a, userBId: b }, { userAId: b, userBId: a }] }
    });
    return Boolean(relation);
}
const worldLocations = [
    { code: 'crossroads', name: 'Перекрёсток', description: 'Безопасный центр мира: торговцы, доска объявлений и пути во все стороны.', minLevel: 1, x: 50, y: 50, npcs: ['Торговец Борин', 'Хранительница Эйра'] },
    { code: 'greenwood', name: 'Зелёный лес', description: 'Тропы грифонов, сбор трав и первые охотничьи задания.', minLevel: 1, x: 25, y: 30, npcs: ['Следопыт Лиан'] },
    { code: 'ashlands', name: 'Пепельные пустоши', description: 'Опасная земля големов и древних руин.', minLevel: 5, x: 75, y: 28, npcs: ['Кузнец Рагнар'] },
    { code: 'abyss_gate', name: 'Врата Бездны', description: 'Мрачный разлом, откуда выходят демоны. Подготовь снаряжение.', minLevel: 10, x: 78, y: 75, npcs: ['Магистр Тар'] },
    { code: 'sunken_ruins', name: 'Затонувшие руины', description: 'Затопленные залы с редкими реликвиями и опасными стражами.', minLevel: 15, x: 22, y: 75, npcs: ['Археолог Мира'] }
];
const worldNpcCatalog = {
    'Торговец Борин': { name: 'Торговец Борин', dialogue: 'Запасы решают исход любого похода. Выбирай снаряжение.', goods: [{ code: 'minor_potion', name: 'Малое зелье', price: 35 }, { code: 'ember_shard', name: 'Осколок пепла', price: 180 }] },
    'Хранительница Эйра': { name: 'Хранительница Эйра', dialogue: 'Добро пожаловать, путник. Следи за событиями мира и помогай другим.' },
    'Следопыт Лиан': { name: 'Следопыт Лиан', dialogue: 'Грифоны гнездятся севернее. Не забывай проверять уровень противника.' },
    'Кузнец Рагнар': { name: 'Кузнец Рагнар', dialogue: 'Пепельные осколки пригодятся для усиления оружия.', goods: [{ code: 'ember_shard', name: 'Осколок пепла', price: 160 }] },
    'Магистр Тар': { name: 'Магистр Тар', dialogue: 'За вратами ждут демоны. Возвращайся, когда будешь готов.' },
    'Археолог Мира': { name: 'Археолог Мира', dialogue: 'В руинах скрыты следы старой цивилизации. Исследуй их осторожно.' }
};
app.get('/api/world', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId }, select: { level: true } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    await Promise.all(worldLocations.map(l => prisma.worldLocation.upsert({ where: { code: l.code }, create: { code: l.code, name: l.name, description: l.description, minLevel: l.minLevel, x: l.x, y: l.y }, update: { name: l.name, description: l.description, minLevel: l.minLevel, x: l.x, y: l.y } })));
    const location = await prisma.playerLocation.upsert({ where: { userId: req.userId }, create: { userId: req.userId }, update: {} });
    const now = new Date();
    const activeCount = await prisma.worldEvent.count({ where: { status: 'active', endsAt: { gt: now } } });
    if (!activeCount)
        await prisma.worldEvent.create({ data: { code: 'forest_patrol', title: 'Патруль Зелёного леса', description: 'Объединитесь, чтобы отогнать стаю грифонов от торгового тракта.', rewardGold: 120, rewardExp: 80, endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
    const events = await prisma.worldEvent.findMany({ where: { status: 'active', startsAt: { lte: now }, endsAt: { gt: now } }, include: { participants: { where: { userId: req.userId } } }, orderBy: { endsAt: 'asc' } });
    return res.json({ locations: worldLocations.map(l => ({ ...l, locked: character.level < l.minLevel })), current: location.location, npcs: worldNpcCatalog, events });
});
app.post('/api/world/move', auth, async (req, res) => {
    const parsed = z.object({ location: z.string().min(2).max(32) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неизвестная локация' });
    const destination = worldLocations.find(l => l.code === parsed.data.location);
    if (!destination)
        return res.status(404).json({ error: 'Локация не найдена' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    if (character.level < destination.minLevel)
        return res.status(403).json({ error: `Для этой области нужен ${destination.minLevel} уровень` });
    const current = await prisma.playerLocation.upsert({ where: { userId: req.userId }, create: { userId: req.userId, location: destination.code }, update: { location: destination.code } });
    io.emit('world:movement', { userId: req.userId, location: destination.code });
    return res.json({ location: current.location, message: `Ты прибыл: ${destination.name}` });
});
app.post('/api/world/npc', auth, async (req, res) => {
    const parsed = z.object({ npc: z.string().min(2).max(40), itemCode: z.string().optional() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неизвестный персонаж' });
    const npc = worldNpcCatalog[parsed.data.npc];
    if (!npc)
        return res.status(404).json({ error: 'NPC не найден' });
    if (!parsed.data.itemCode)
        return res.json({ npc, goods: npc.goods || [] });
    const good = npc.goods?.find(g => g.code === parsed.data.itemCode);
    if (!good)
        return res.status(400).json({ error: 'Этот товар здесь не продаётся' });
    try {
        await prisma.$transaction(async (tx) => {
            const buyer = await tx.character.findUniqueOrThrow({ where: { userId: req.userId } });
            const debit = await tx.character.updateMany({ where: { userId: req.userId, gold: { gte: good.price } }, data: { gold: { decrement: good.price } } });
            if (!debit.count)
                throw new Error('Недостаточно золота');
            await tx.inventoryItem.upsert({ where: { characterId_code: { characterId: buyer.id, code: good.code } }, create: { characterId: buyer.id, code: good.code, quantity: 1 }, update: { quantity: { increment: 1 } } });
        });
        return res.json({ bought: good.name, price: good.price });
    }
    catch (e) {
        return res.status(409).json({ error: e?.message || 'Покупка не удалась' });
    }
});
app.get('/api/world/events', auth, async (_req, res) => {
    const now = new Date();
    const events = await prisma.worldEvent.findMany({ where: { status: 'active', startsAt: { lte: now }, endsAt: { gt: now } }, include: { _count: { select: { participants: true } } }, orderBy: { endsAt: 'asc' } });
    return res.json({ events });
});
app.post('/api/world/events/join', auth, async (req, res) => {
    const parsed = z.object({ eventId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрано событие' });
    try {
        const result = await prisma.$transaction(async (tx) => {
            const event = await tx.worldEvent.findUnique({ where: { id: parsed.data.eventId } });
            const now = new Date();
            if (!event || event.status !== 'active' || event.startsAt > now || event.endsAt <= now)
                throw new Error('Событие уже завершено');
            await tx.worldEventParticipant.create({ data: { eventId: event.id, userId: req.userId } });
            await tx.character.update({ where: { userId: req.userId }, data: { gold: { increment: event.rewardGold }, experience: { increment: event.rewardExp } } });
            return event;
        });
        return res.json({ joined: true, reward: { gold: result.rewardGold, experience: result.rewardExp } });
    }
    catch (e) {
        return res.status(409).json({ error: e?.code === 'P2002' ? 'Ты уже участвовал в этом событии' : e?.message || 'Не удалось участвовать' });
    }
});
// Open-world hunting and gathering (v15)
const worldMonsterCatalog = {
    crossroads: [{ code: 'wild_rat', name: 'Дорожная крыса', level: 1, hp: 180, attack: 18, gold: 25, exp: 12, drop: 'minor_potion', chance: 12 }],
    greenwood: [
        { code: 'forest_wolf', name: 'Лесной волк', level: 1, hp: 300, attack: 35, gold: 65, exp: 28, drop: 'minor_potion', chance: 18 },
        { code: 'griffin', name: 'Молодой грифон', level: 2, hp: 420, attack: 48, gold: 95, exp: 42, drop: 'griffin_feather', chance: 14 }
    ],
    ashlands: [{ code: 'golem', name: 'Пепельный голем', level: 5, hp: 760, attack: 82, gold: 170, exp: 75, drop: 'ember_shard', chance: 28 }],
    abyss_gate: [{ code: 'abyss', name: 'Демон бездны', level: 10, hp: 1180, attack: 125, gold: 290, exp: 130, drop: 'ember_blade', chance: 8 }],
    sunken_ruins: [{ code: 'ancient_guardian', name: 'Древний страж', level: 15, hp: 1650, attack: 165, gold: 420, exp: 190, drop: 'ancient_core', chance: 10 }]
};
const worldResourceCatalog = {
    crossroads: [{ code: 'wild_herbs', name: 'Лекарственные травы', item: 'minor_potion', quantity: 1, level: 1 }],
    greenwood: [{ code: 'moonleaf', name: 'Лунный лист', item: 'moonleaf', quantity: 2, level: 1 }],
    ashlands: [{ code: 'ash_ore', name: 'Пепельная руда', item: 'ember_shard', quantity: 1, level: 5 }],
    abyss_gate: [{ code: 'void_crystal', name: 'Кристалл пустоты', item: 'void_crystal', quantity: 1, level: 10 }],
    sunken_ruins: [{ code: 'sunken_relic', name: 'Обломок реликвии', item: 'ancient_core', quantity: 1, level: 15 }]
};
app.get('/api/world/hunt', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const location = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const code = location?.location || 'crossroads';
    const monsters = (worldMonsterCatalog[code] || []).map(m => ({ ...m, locked: character.level < m.level }));
    const nearby = await prisma.playerLocation.findMany({ where: { location: code, userId: { not: req.userId } }, include: { user: { select: { username: true } } }, take: 20, orderBy: { updatedAt: 'desc' } });
    return res.json({ location: code, monsters, resources: (worldResourceCatalog[code] || []).map(r => ({ ...r, locked: character.level < r.level })), nearby: nearby.map(p => ({ username: p.user.username, lastSeen: p.updatedAt })) });
});
app.post('/api/world/hunt/attack', auth, async (req, res) => {
    const parsed = z.object({ monsterCode: z.string().min(2).max(40) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери монстра' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const location = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const monster = (worldMonsterCatalog[location?.location || 'crossroads'] || []).find(m => m.code === parsed.data.monsterCode);
    if (!monster)
        return res.status(403).json({ error: 'Этот монстр не обитает в текущей области' });
    if (character.level < monster.level)
        return res.status(403).json({ error: `Нужен уровень ${monster.level}` });
    if (character.hp <= 0)
        return res.status(409).json({ error: 'Восстанови здоровье перед охотой' });
    const activity = await prisma.worldActivity.upsert({ where: { userId: req.userId }, create: { userId: req.userId }, update: {} });
    if (activity.lastHuntAt && Date.now() - activity.lastHuntAt.getTime() < 8000)
        return res.status(429).json({ error: 'Передышка после боя: подожди несколько секунд' });
    const stats = await getCombatStats(prisma, character);
    const damage = Math.max(1, stats.attack + Math.floor(Math.random() * 30));
    const enemyDamage = Math.max(0, monster.attack - Math.floor(stats.defense * 0.35));
    const won = damage * 4 >= monster.hp;
    const drop = won && Math.random() * 100 < monster.chance;
    const updated = await prisma.$transaction(async (tx) => {
        await tx.worldActivity.update({ where: { userId: req.userId }, data: { lastHuntAt: new Date() } });
        const nextExp = character.experience + (won ? monster.exp : 0);
        const levelUp = nextExp >= character.level * 100;
        const saved = await tx.character.update({ where: { id: character.id }, data: {
                hp: Math.max(0, character.hp - (won ? enemyDamage : enemyDamage * 2)),
                gold: { increment: won ? monster.gold : 0 },
                experience: levelUp ? nextExp - character.level * 100 : nextExp,
                ...(levelUp ? { level: { increment: 1 }, skillPoints: { increment: 1 } } : {})
            } });
        if (drop)
            await tx.inventoryItem.upsert({ where: { characterId_code: { characterId: character.id, code: monster.drop } }, create: { characterId: character.id, code: monster.drop, quantity: 1, rarity: 'rare' }, update: { quantity: { increment: 1 } } });
        return saved;
    });
    return res.json({ won, damage, enemyDamage: won ? enemyDamage : enemyDamage * 2, reward: won ? { gold: monster.gold, experience: monster.exp, drop: drop ? monster.drop : null } : null, levelUp: won && updated.level > character.level, character: updated });
});
app.post('/api/world/gather', auth, async (req, res) => {
    const parsed = z.object({ resourceCode: z.string().min(2).max(40) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Выбери ресурс' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const location = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const resource = (worldResourceCatalog[location?.location || 'crossroads'] || []).find(r => r.code === parsed.data.resourceCode);
    if (!resource)
        return res.status(403).json({ error: 'Ресурс недоступен в этой области' });
    if (character.level < resource.level)
        return res.status(403).json({ error: `Нужен уровень ${resource.level}` });
    const activity = await prisma.worldActivity.upsert({ where: { userId: req.userId }, create: { userId: req.userId }, update: {} });
    if (activity.lastGatherAt && Date.now() - activity.lastGatherAt.getTime() < 60000)
        return res.status(429).json({ error: 'Ресурсы восстановятся через минуту' });
    await prisma.$transaction(async (tx) => {
        await tx.worldActivity.update({ where: { userId: req.userId }, data: { lastGatherAt: new Date() } });
        await tx.inventoryItem.upsert({ where: { characterId_code: { characterId: character.id, code: resource.item } }, create: { characterId: character.id, code: resource.item, quantity: resource.quantity }, update: { quantity: { increment: resource.quantity } } });
    });
    return res.json({ gathered: resource.name, item: resource.item, quantity: resource.quantity });
});
// Shared world bosses and consensual PvP duels (v16)
const worldBossCatalog = {
    greenwood: { code: 'forest_ancient', name: 'Древний лесной дракон', hp: 12000, minLevel: 3, rewardGold: 900, rewardExp: 420 },
    ashlands: { code: 'ash_titan', name: 'Пепельный титан', hp: 22000, minLevel: 7, rewardGold: 1800, rewardExp: 850 },
    abyss_gate: { code: 'abyss_lord', name: 'Повелитель Бездны', hp: 40000, minLevel: 12, rewardGold: 3500, rewardExp: 1700 },
    sunken_ruins: { code: 'drowned_king', name: 'Затонувший король', hp: 60000, minLevel: 17, rewardGold: 5200, rewardExp: 2600 }
};
app.get('/api/world/boss', auth, async (req, res) => {
    const loc = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const location = loc?.location || 'crossroads';
    const catalog = worldBossCatalog[location];
    if (!catalog)
        return res.json({ boss: null, message: 'В этой области нет мирового босса' });
    let boss = await prisma.worldBossSpawn.findUnique({ where: { location } });
    if (!boss || boss.expiresAt <= new Date() || boss.hp <= 0) {
        boss = await prisma.worldBossSpawn.upsert({
            where: { location },
            create: { location, bossCode: catalog.code, name: catalog.name, hp: catalog.hp, maxHp: catalog.hp, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) },
            update: { bossCode: catalog.code, name: catalog.name, hp: catalog.hp, maxHp: catalog.hp, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) }
        });
    }
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    const top = await prisma.worldBossContribution.findMany({ where: { spawnId: boss.id }, orderBy: { damage: 'desc' }, take: 5 });
    return res.json({ boss, minLevel: catalog.minLevel, locked: !character || character.level < catalog.minLevel, top });
});
app.post('/api/world/boss/attack', auth, async (req, res) => {
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const loc = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const location = loc?.location || 'crossroads';
    const catalog = worldBossCatalog[location];
    if (!catalog || character.level < catalog.minLevel)
        return res.status(403).json({ error: 'Мировой босс пока недоступен' });
    let boss = await prisma.worldBossSpawn.findUnique({ where: { location } });
    if (!boss || boss.hp <= 0 || boss.expiresAt <= new Date())
        return res.status(409).json({ error: 'Босс исчез. Обнови список мировых событий' });
    const stats = await getCombatStats(prisma, character);
    const damage = Math.max(1, Math.floor(stats.attack * (0.8 + Math.random() * 0.4)));
    const applied = Math.min(damage, boss.hp);
    const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.worldBossSpawn.findUnique({ where: { id: boss.id } });
        if (!current || current.hp <= 0)
            throw new Error('Босс уже повержен');
        const newHp = Math.max(0, current.hp - applied);
        const saved = await tx.worldBossSpawn.update({ where: { id: current.id }, data: { hp: newHp } });
        await tx.worldBossContribution.upsert({ where: { spawnId_userId: { spawnId: current.id, userId: req.userId } }, create: { spawnId: current.id, userId: req.userId, damage: applied }, update: { damage: { increment: applied } } });
        return saved;
    });
    io.emit('world:boss', { location, hp: updated.hp, maxHp: updated.maxHp });
    return res.json({ damage: applied, boss: updated, defeated: updated.hp <= 0 });
});
app.post('/api/world/boss/claim', auth, async (req, res) => {
    const loc = await prisma.playerLocation.findUnique({ where: { userId: req.userId } });
    const boss = await prisma.worldBossSpawn.findUnique({ where: { location: loc?.location || 'crossroads' } });
    if (!boss || boss.hp > 0)
        return res.status(409).json({ error: 'Босс ещё не повержен' });
    const contribution = await prisma.worldBossContribution.findUnique({ where: { spawnId_userId: { spawnId: boss.id, userId: req.userId } } });
    if (!contribution || contribution.damage <= 0 || contribution.claimed)
        return res.status(403).json({ error: 'Награда недоступна или уже получена' });
    const catalog = worldBossCatalog[boss.location];
    await prisma.$transaction(async (tx) => {
        await tx.worldBossContribution.update({ where: { id: contribution.id }, data: { claimed: true } });
        await tx.character.update({ where: { userId: req.userId }, data: { gold: { increment: catalog.rewardGold }, experience: { increment: catalog.rewardExp } } });
    });
    return res.json({ gold: catalog.rewardGold, experience: catalog.rewardExp });
});
// PvP is invitation-based: no player can be attacked without accepting a duel.
app.post('/api/world/duels/challenge', auth, async (req, res) => {
    const parsed = z.object({ targetUsername: z.string().min(2).max(32) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажи имя игрока' });
    const target = await prisma.user.findUnique({ where: { username: parsed.data.targetUsername } });
    if (!target || target.id === req.userId)
        return res.status(404).json({ error: 'Игрок не найден' });
    const [mine, theirs, myLoc, theirLoc] = await Promise.all([
        prisma.character.findUnique({ where: { userId: req.userId } }), prisma.character.findUnique({ where: { userId: target.id } }),
        prisma.playerLocation.findUnique({ where: { userId: req.userId } }), prisma.playerLocation.findUnique({ where: { userId: target.id } })
    ]);
    if (!mine || !theirs || (myLoc?.location || 'crossroads') !== (theirLoc?.location || 'crossroads'))
        return res.status(403).json({ error: 'Для дуэли игроки должны находиться в одной области' });
    const pending = await prisma.playerDuel.create({ data: { challengerId: req.userId, targetId: target.id, challengerHp: mine.hp, targetHp: theirs.hp } });
    return res.json({ duel: pending, target: target.username });
});
app.get('/api/world/duels', auth, async (req, res) => {
    const duels = await prisma.playerDuel.findMany({ where: { status: { in: ['pending', 'active'] }, OR: [{ challengerId: req.userId }, { targetId: req.userId }] }, orderBy: { createdAt: 'desc' }, take: 20 });
    return res.json({ duels: duels.map(d => ({ ...d, canAccept: d.targetId === req.userId && d.status === 'pending', canStrike: d.turnUserId === req.userId && d.status === 'active' })) });
});
app.post('/api/world/duels/accept', auth, async (req, res) => {
    const parsed = z.object({ duelId: z.string() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректная дуэль' });
    const duel = await prisma.playerDuel.findUnique({ where: { id: parsed.data.duelId } });
    if (!duel || duel.targetId !== req.userId || duel.status !== 'pending')
        return res.status(404).json({ error: 'Приглашение не найдено' });
    const [a, b] = await Promise.all([prisma.character.findUnique({ where: { userId: duel.challengerId } }), prisma.character.findUnique({ where: { userId: duel.targetId } })]);
    if (!a || !b)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const active = await prisma.playerDuel.update({ where: { id: duel.id }, data: { status: 'active', challengerHp: a.hp, targetHp: b.hp, turnUserId: duel.challengerId } });
    return res.json({ duel: active });
});
app.post('/api/world/duels/strike', auth, async (req, res) => {
    const parsed = z.object({ duelId: z.string() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Некорректная дуэль' });
    const duel = await prisma.playerDuel.findUnique({ where: { id: parsed.data.duelId } });
    if (!duel || duel.status !== 'active' || duel.turnUserId !== req.userId)
        return res.status(409).json({ error: 'Сейчас не твой ход' });
    const attacker = await prisma.character.findUnique({ where: { userId: req.userId } });
    const defenderId = duel.challengerId === req.userId ? duel.targetId : duel.challengerId;
    const defender = await prisma.character.findUnique({ where: { userId: defenderId } });
    if (!attacker || !defender)
        return res.status(404).json({ error: 'Персонаж не найден' });
    const stats = await getCombatStats(prisma, attacker);
    const damage = Math.max(1, Math.floor(stats.attack * (0.65 + Math.random() * 0.25) - defender.defense * 0.15));
    const isChallenger = defenderId === duel.challengerId;
    const nextHp = Math.max(0, (isChallenger ? duel.challengerHp : duel.targetHp) - damage);
    const winnerId = nextHp <= 0 ? req.userId : null;
    const updated = await prisma.playerDuel.update({ where: { id: duel.id }, data: {
            ...(isChallenger ? { challengerHp: nextHp } : { targetHp: nextHp }),
            status: winnerId ? 'completed' : 'active', winnerId, turnUserId: winnerId ? null : defenderId
        } });
    return res.json({ duel: updated, damage, winnerId });
});
// Guild raid, PvP ladder and player leaderboard (v17)
const guildRaidCatalog = [
    { code: 'grove_colossus', name: 'Колосс древней рощи', hp: 50000, gold: 1800, exp: 900 },
    { code: 'ash_dragon', name: 'Пепельный дракон', hp: 90000, gold: 3200, exp: 1600 },
    { code: 'abyss_emperor', name: 'Император Бездны', hp: 160000, gold: 6000, exp: 3000 }
];
app.get('/api/clans/raid', auth, async (req, res) => {
    const membership = await prisma.clanMember.findFirst({ where: { userId: req.userId } });
    if (!membership)
        return res.status(403).json({ error: 'Для рейда вступи в клан' });
    let raid = await prisma.guildRaid.findFirst({ where: { status: 'active', endsAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!raid) {
        const template = guildRaidCatalog[Math.floor(Date.now() / (24 * 60 * 60 * 1000)) % guildRaidCatalog.length];
        raid = await prisma.guildRaid.create({ data: { ...template, maxHp: template.hp, status: 'active', rewardGold: template.gold, rewardExp: template.exp, endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    }
    const contribution = await prisma.guildRaidContribution.findUnique({ where: { raidId_userId: { raidId: raid.id, userId: req.userId } } });
    const clanDamage = await prisma.guildRaidContribution.aggregate({ where: { raidId: raid.id, clanId: membership.clanId }, _sum: { damage: true } });
    return res.json({ raid, contribution, clanDamage: clanDamage._sum.damage || 0 });
});
app.post('/api/clans/raid/attack', auth, async (req, res) => {
    const membership = await prisma.clanMember.findFirst({ where: { userId: req.userId } });
    if (!membership)
        return res.status(403).json({ error: 'Для рейда вступи в клан' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    const raid = await prisma.guildRaid.findFirst({ where: { status: 'active', endsAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!character || !raid)
        return res.status(404).json({ error: 'Активный рейд не найден' });
    const stats = await getCombatStats(prisma, character);
    const damage = Math.max(1, Math.floor(stats.attack * (0.9 + Math.random() * 0.3)));
    const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.guildRaid.findUnique({ where: { id: raid.id } });
        if (!current || current.status !== 'active' || current.hp <= 0)
            throw new Error('Рейд уже завершён');
        const hp = Math.max(0, current.hp - damage);
        const saved = await tx.guildRaid.update({ where: { id: raid.id }, data: { hp, ...(hp === 0 ? { status: 'completed' } : {}) } });
        await tx.guildRaidContribution.upsert({
            where: { raidId_userId: { raidId: raid.id, userId: req.userId } },
            create: { raidId: raid.id, userId: req.userId, clanId: membership.clanId, damage: Math.min(damage, current.hp) },
            update: { damage: { increment: Math.min(damage, current.hp) } }
        });
        return saved;
    });
    return res.json({ damage: Math.min(damage, raid.hp), raid: updated });
});
app.post('/api/clans/raid/claim', auth, async (req, res) => {
    const membership = await prisma.clanMember.findFirst({ where: { userId: req.userId } });
    const raid = await prisma.guildRaid.findFirst({ where: { status: 'completed' }, orderBy: { createdAt: 'desc' } });
    if (!membership || !raid)
        return res.status(404).json({ error: 'Завершённый рейд не найден' });
    const contribution = await prisma.guildRaidContribution.findUnique({ where: { raidId_userId: { raidId: raid.id, userId: req.userId } } });
    if (!contribution || contribution.clanId !== membership.clanId || contribution.claimed || contribution.damage <= 0)
        return res.status(403).json({ error: 'Награда недоступна или уже получена' });
    const gold = Math.max(50, Math.floor(raid.rewardGold * Math.min(1, contribution.damage / 1500)));
    const exp = Math.max(25, Math.floor(raid.rewardExp * Math.min(1, contribution.damage / 1500)));
    await prisma.$transaction(async (tx) => {
        const claim = await tx.guildRaidContribution.updateMany({ where: { id: contribution.id, claimed: false, clanId: membership.clanId }, data: { claimed: true } });
        if (claim.count !== 1)
            throw new Error('Награда уже получена');
        await tx.character.update({ where: { userId: req.userId }, data: { gold: { increment: gold }, experience: { increment: exp } } });
    });
    return res.json({ gold, experience: exp });
});
app.get('/api/leaderboard', auth, async (_req, res) => {
    const [levels, clans, pvp] = await Promise.all([
        prisma.character.findMany({ orderBy: [{ level: 'desc' }, { experience: 'desc' }], take: 20, include: { user: { select: { username: true } } } }),
        prisma.clan.findMany({ orderBy: [{ level: 'desc' }], take: 10, include: { _count: { select: { members: true } } } }),
        prisma.playerDuel.groupBy({ by: ['winnerId'], where: { status: 'completed', winnerId: { not: null } }, _count: { winnerId: true }, orderBy: { _count: { winnerId: 'desc' } }, take: 20 })
    ]);
    const pvpRows = await Promise.all(pvp.map(async (row) => {
        const user = await prisma.user.findUnique({ where: { id: row.winnerId }, select: { username: true } });
        return { username: user?.username || 'Игрок', wins: row._count.winnerId };
    }));
    return res.json({
        players: levels.map((c, i) => ({ rank: i + 1, username: c.user.username, level: c.level, experience: c.experience })),
        clans: clans.map((c, i) => ({ rank: i + 1, name: c.name, level: c.level, members: c._count.members })),
        pvp: pvpRows
    });
});
app.get('/api/social/friends', auth, async (req, res) => {
    const rows = await prisma.friendship.findMany({
        where: { OR: [{ userAId: req.userId }, { userBId: req.userId }] },
        include: { userA: { select: { id: true, username: true } }, userB: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' }
    });
    return res.json({ friends: rows.map(r => ({ id: r.id, status: r.status, user: r.userAId === req.userId ? r.userB : r.userA, incoming: r.userBId === req.userId })) });
});
app.post('/api/social/friends/request', auth, async (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(2).max(24) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Укажи имя игрока' });
    const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (!target || target.id === req.userId)
        return res.status(404).json({ error: 'Игрок не найден' });
    const existing = await prisma.friendship.findFirst({ where: { OR: [{ userAId: req.userId, userBId: target.id }, { userAId: target.id, userBId: req.userId }] } });
    if (existing?.status === 'accepted')
        return res.status(409).json({ error: 'Вы уже друзья' });
    if (existing?.status === 'pending' && existing.userBId === req.userId) {
        await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'accepted' } });
        return res.json({ accepted: true });
    }
    if (existing)
        return res.status(409).json({ error: 'Заявка уже отправлена' });
    await prisma.friendship.create({ data: { userAId: req.userId, userBId: target.id } });
    return res.status(201).json({ sent: true });
});
app.post('/api/social/friends/accept', auth, async (req, res) => {
    const parsed = z.object({ friendshipId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрана заявка' });
    const updated = await prisma.friendship.updateMany({ where: { id: parsed.data.friendshipId, userBId: req.userId, status: 'pending' }, data: { status: 'accepted' } });
    if (!updated.count)
        return res.status(404).json({ error: 'Заявка не найдена' });
    return res.json({ accepted: true });
});
app.get('/api/social/mail', auth, async (req, res) => {
    const messages = await prisma.mailMessage.findMany({
        where: { OR: [{ recipientId: req.userId }, { senderId: req.userId }] },
        include: { sender: { select: { username: true } }, recipient: { select: { username: true } } },
        orderBy: { createdAt: 'desc' }, take: 50
    });
    return res.json({ messages });
});
app.post('/api/social/mail/send', auth, async (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(2).max(24), subject: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Проверь адресата, тему и текст письма' });
    const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (!target || target.id === req.userId)
        return res.status(404).json({ error: 'Получатель не найден' });
    const message = await prisma.mailMessage.create({ data: { senderId: req.userId, recipientId: target.id, subject: parsed.data.subject, body: parsed.data.body } });
    return res.status(201).json({ message });
});
app.post('/api/social/mail/read', auth, async (req, res) => {
    const parsed = z.object({ messageId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрано письмо' });
    const updated = await prisma.mailMessage.updateMany({ where: { id: parsed.data.messageId, recipientId: req.userId }, data: { readAt: new Date() } });
    if (!updated.count)
        return res.status(404).json({ error: 'Письмо не найдено' });
    return res.json({ read: true });
});
app.get('/api/social/messages/:username', auth, async (req, res) => {
    const target = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!target || !(await areFriends(req.userId, target.id)))
        return res.status(403).json({ error: 'Личные сообщения доступны друзьям' });
    const messages = await prisma.directMessage.findMany({
        where: { OR: [{ senderId: req.userId, recipientId: target.id }, { senderId: target.id, recipientId: req.userId }] },
        include: { sender: { select: { username: true } } }, orderBy: { createdAt: 'asc' }, take: 100
    });
    return res.json({ messages });
});
app.post('/api/social/messages/send', auth, async (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(2).max(24), body: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Сообщение пустое или слишком длинное' });
    const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (!target || !(await areFriends(req.userId, target.id)))
        return res.status(403).json({ error: 'Личные сообщения доступны только друзьям' });
    const message = await prisma.directMessage.create({ data: { senderId: req.userId, recipientId: target.id, body: parsed.data.body }, include: { sender: { select: { username: true } } } });
    io.to(`user:${target.id}`).emit('social:message', message);
    return res.status(201).json({ message });
});
app.get('/api/social/gifts', auth, async (req, res) => {
    const gifts = await prisma.playerGift.findMany({
        where: { OR: [{ recipientId: req.userId }, { senderId: req.userId }] },
        include: { sender: { select: { username: true } }, recipient: { select: { username: true } } },
        orderBy: { createdAt: 'desc' }, take: 50
    });
    return res.json({ gifts });
});
app.post('/api/social/gifts/send', auth, async (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(2).max(24), gold: z.number().int().min(0).max(100000), itemCode: z.enum(['minor_potion', 'rusty_sword', 'ember_shard', 'ember_blade']).optional(), quantity: z.number().int().min(1).max(20).optional() }).refine(v => v.gold > 0 || Boolean(v.itemCode && v.quantity), 'Укажи подарок').safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Проверь состав подарка' });
    const target = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (!target || target.id === req.userId)
        return res.status(404).json({ error: 'Получатель не найден' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    try {
        const gift = await prisma.$transaction(async (tx) => {
            if (parsed.data.gold > 0) {
                const debit = await tx.character.updateMany({ where: { userId: req.userId, gold: { gte: parsed.data.gold } }, data: { gold: { decrement: parsed.data.gold } } });
                if (!debit.count)
                    throw new Error('Недостаточно золота');
            }
            if (parsed.data.itemCode && parsed.data.quantity) {
                const item = await tx.inventoryItem.findUnique({ where: { characterId_code: { characterId: character.id, code: parsed.data.itemCode } } });
                if (!item || item.quantity < parsed.data.quantity)
                    throw new Error('Недостаточно предметов');
                if (item.quantity === parsed.data.quantity)
                    await tx.inventoryItem.delete({ where: { id: item.id } });
                else
                    await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: { decrement: parsed.data.quantity } } });
            }
            return tx.playerGift.create({ data: { senderId: req.userId, recipientId: target.id, gold: parsed.data.gold, itemCode: parsed.data.itemCode, quantity: parsed.data.quantity || 0 } });
        });
        io.to(`user:${target.id}`).emit('social:notification', { type: 'gift' });
        io.to(`user:${target.id}`).emit('social:notification', { type: 'gift' });
        return res.status(201).json({ gift });
    }
    catch (e) {
        return res.status(409).json({ error: e?.message || 'Не удалось отправить подарок' });
    }
});
app.post('/api/social/gifts/claim', auth, async (req, res) => {
    const parsed = z.object({ giftId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбран подарок' });
    try {
        const result = await prisma.$transaction(async (tx) => {
            const gift = await tx.playerGift.findUnique({ where: { id: parsed.data.giftId } });
            if (!gift || gift.recipientId !== req.userId || gift.claimed)
                throw new Error('Подарок недоступен или уже получен');
            const claimed = await tx.playerGift.updateMany({ where: { id: gift.id, recipientId: req.userId, claimed: false }, data: { claimed: true } });
            if (!claimed.count)
                throw new Error('Подарок уже получен');
            if (gift.gold > 0)
                await tx.character.update({ where: { userId: req.userId }, data: { gold: { increment: gift.gold } } });
            if (gift.itemCode && gift.quantity > 0) {
                const character = await tx.character.findUniqueOrThrow({ where: { userId: req.userId } });
                await tx.inventoryItem.upsert({ where: { characterId_code: { characterId: character.id, code: gift.itemCode } }, create: { characterId: character.id, code: gift.itemCode, quantity: gift.quantity }, update: { quantity: { increment: gift.quantity } } });
            }
            return gift;
        });
        return res.json({ gift: result });
    }
    catch (e) {
        return res.status(409).json({ error: e?.message || 'Не удалось получить подарок' });
    }
});
app.get('/api/auction', auth, async (_req, res) => {
    const listings = await prisma.auctionListing.findMany({
        where: { status: 'active' }, include: { seller: { select: { username: true } } },
        orderBy: { createdAt: 'desc' }, take: 50
    });
    return res.json({ listings });
});
app.post('/api/auction/list', auth, async (req, res) => {
    const parsed = z.object({ itemCode: z.enum(['minor_potion', 'rusty_sword', 'ember_shard', 'ember_blade']), quantity: z.number().int().min(1).max(99), price: z.number().int().min(1).max(10000000) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Проверь предмет, количество и цену' });
    const character = await prisma.character.findUnique({ where: { userId: req.userId } });
    if (!character)
        return res.status(404).json({ error: 'Персонаж не найден' });
    try {
        const listing = await prisma.$transaction(async (tx) => {
            const item = await tx.inventoryItem.findUnique({ where: { characterId_code: { characterId: character.id, code: parsed.data.itemCode } } });
            if (!item || item.quantity < parsed.data.quantity)
                throw new Error('Недостаточно предметов');
            if (item.quantity === parsed.data.quantity)
                await tx.inventoryItem.delete({ where: { id: item.id } });
            else
                await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: { decrement: parsed.data.quantity } } });
            return tx.auctionListing.create({ data: { sellerId: req.userId, ...parsed.data } });
        });
        return res.status(201).json({ listing });
    }
    catch (e) {
        return res.status(409).json({ error: e?.message || 'Не удалось выставить предмет' });
    }
});
app.post('/api/auction/buy', auth, async (req, res) => {
    const parsed = z.object({ listingId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Не выбрано предложение' });
    try {
        const result = await prisma.$transaction(async (tx) => {
            const listing = await tx.auctionListing.findUnique({ where: { id: parsed.data.listingId } });
            if (!listing || listing.status !== 'active')
                throw new Error('Предложение уже недоступно');
            if (listing.sellerId === req.userId)
                throw new Error('Нельзя купить собственный лот');
            const buyer = await tx.character.findUnique({ where: { userId: req.userId } });
            const seller = await tx.character.findUnique({ where: { userId: listing.sellerId } });
            if (!buyer || !seller || buyer.gold < listing.price)
                throw new Error('Недостаточно золота');
            const claimed = await tx.auctionListing.updateMany({ where: { id: listing.id, status: 'active' }, data: { status: 'sold' } });
            if (claimed.count !== 1)
                throw new Error('Лот уже куплен');
            await tx.character.update({ where: { id: buyer.id }, data: { gold: { decrement: listing.price } } });
            await tx.character.update({ where: { id: seller.id }, data: { gold: { increment: listing.price } } });
            await tx.inventoryItem.upsert({
                where: { characterId_code: { characterId: buyer.id, code: listing.itemCode } },
                create: { characterId: buyer.id, code: listing.itemCode, quantity: listing.quantity },
                update: { quantity: { increment: listing.quantity } }
            });
            return tx.character.findUniqueOrThrow({ where: { id: buyer.id } });
        });
        return res.json({ character: result, message: 'Покупка завершена' });
    }
    catch (e) {
        return res.status(409).json({ error: e?.message || 'Покупка не удалась' });
    }
});
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' } });
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token)
            return next(new Error('Требуется авторизация'));
        const payload = jwt.verify(token, jwtSecret);
        if (typeof payload.sub !== 'string')
            return next(new Error('Недействительная сессия'));
        socket.data.userId = payload.sub;
        next();
    }
    catch {
        next(new Error('Недействительная сессия'));
    }
});
io.on('connection', socket => {
    socket.join('global');
    socket.join(`user:${socket.data.userId}`);
    socket.on('chat:send', async (raw) => {
        const parsed = z.object({ message: z.string().trim().min(1).max(300), channel: z.enum(['global', 'clan']).default('global') }).safeParse(raw);
        if (!parsed.success)
            return;
        const user = await prisma.user.findUnique({ where: { id: socket.data.userId }, select: { username: true } });
        if (!user)
            return;
        const saved = await prisma.chatMessage.create({
            data: { userId: socket.data.userId, username: user.username, message: parsed.data.message, channel: parsed.data.channel }
        });
        io.to(parsed.data.channel).emit('chat:message', { id: saved.id, username: saved.username, message: saved.message, channel: saved.channel, createdAt: saved.createdAt });
    });
});
server.listen(port, () => console.log(`WarAxe API listening on :${port}`));
process.on('SIGINT', async () => { await prisma.$disconnect(); server.close(); });
