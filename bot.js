import pkg from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import cron from 'node-cron';

const { 
  Client, 
  EmbedBuilder, 
  GatewayIntentBits, 
  Events, 
  ActivityType, 
  ButtonBuilder, 
  ButtonStyle, 
  ActionRowBuilder 
} = pkg;

dotenv.config();

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ] 
});

const SCHOOL_DATA_FILE = './schoolData.json';
let schoolData = { guilds: {} };

function loadSchoolData() {
  try {
    const data = fs.readFileSync(SCHOOL_DATA_FILE, 'utf8');
    schoolData = JSON.parse(data);
  } catch (err) {
    schoolData = { guilds: {} };
  }
}

function saveSchoolData() {
  try {
    fs.writeFileSync(SCHOOL_DATA_FILE, JSON.stringify(schoolData, null, 2));
  } catch (err) {
    console.error('Error saving school data:', err);
  }
}

loadSchoolData();

client.once(Events.ClientReady, async () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);

  cron.schedule('0 6 * * *', () => {
    sendMealInfoAutomatically('조식', 6, 0);
  }, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('0 10 * * *', () => {
    sendMealInfoAutomatically('중식', 10, 0);
  }, {
    timezone: 'Asia/Seoul',
  });

  cron.schedule('30 16 * * *', () => {
    sendMealInfoAutomatically('석식', 16, 30);
  }, {
    timezone: 'Asia/Seoul',
  });
});

client.on(Events.ClientReady, async () => {
  setInterval(() => {
    client.user.setPresence({
      activities: [{ name: "자바 잡기", type: ActivityType.Playing }],
    });
  }, 1000);

  await client.application.commands.set([
    {
      name: '학교등록',
      description: '학교와 학급을 등록하고 전용 채널을 생성합니다.',
      options: [
        {
          name: '학교명',
          description: '등록할 학교 이름',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
        {
          name: '학년',
          description: '등록할 학년',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
        {
          name: '반',
          description: '등록할 반',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
        {
          name: '학과',
          description: '등록할 학과',
          required: false,
          type: pkg.ApplicationCommandOptionType.String,
        }
      ],
    },
    {
      name: '급식',
      description: '급식 정보를 알려줍니다.',
      options: [
        {
          name: '날짜',
          description: '급식 정보를 확인할 날짜 (기본: 오늘)',
          required: false,
          type: pkg.ApplicationCommandOptionType.String,
        }
      ],
    },
    {
      name: '시간표',
      description: '시간표 정보를 알려줍니다.',
      options: [
        {
          name: '날짜',
          description: '시간표 정보를 확인할 날짜 (기본: 오늘)',
          required: false,
          type: pkg.ApplicationCommandOptionType.String,
        }
      ],
    }
  ]);
});

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day, formatted: `${year}-${month}-${day}` };
}

function getDayOfWeek(yyyyMMdd) {
  const day = ['일', '월', '화', '수', '목', '금', '토'];
  const dayOfWeek = new Date(yyyyMMdd).getDay();
  return day[dayOfWeek];
}

function getDateOffset(dateStr, offset) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + offset);
  return formatDate(date);
}

async function getSchoolInfo(schoolName) {
  const url = `https://open.neis.go.kr/hub/schoolInfo?Key=${process.env.KEY}&Type=json&SCHUL_NM=${schoolName.replace('학교: ', '')}`;
  try {
    const response = await axios.get(url);
    const data = response.data;
    if (data.RESULT && data.RESULT.CODE === 'INFO-200') return null;
    return data.schoolInfo[1].row[0];
  } catch (error) {
    console.error('Error fetching school info:', error);
    return null;
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const [action, date, mealType] = interaction.customId.split('|');
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const schoolInfo = schoolData.guilds[guildId]?.channels[channelId];

    if (!schoolInfo) {
      await interaction.reply({ content: '이 채널은 학교와 학급이 설정된 전용 채널이 아닙니다.', ephemeral: true });
      return;
    }

    if (action === 'meal') {
      const direction = mealType || 'next';
      const newDate = getDateOffset(date, direction === 'next' ? 1 : -1);
      await showMealInfo(interaction, newDate.formatted, schoolInfo, null, true);
    } else if (action === 'mealType') {
      await showMealInfo(interaction, date, schoolInfo, mealType, true);
    } else if (action === 'timetable') {
      const direction = mealType || 'next';
      const newDate = getDateOffset(date, direction === 'next' ? 1 : -1);
      await showTimeTableInfo(interaction, schoolInfo, newDate.formatted, true);
    }
    return;
  }

  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === '학교등록') {
    const schoolName = interaction.options.getString('학교명');
    const grade = interaction.options.getString('학년');
    const cls = interaction.options.getString('반');
    const department = interaction.options.getString('학과') || '';
    const guildId = interaction.guildId;

    const schoolInfo = await getSchoolInfo(schoolName);
    if (!schoolInfo) {
      await interaction.reply({ content: '해당 학교를 찾을 수 없습니다.', ephemeral: true });
      return;
    }

    const channelName = `${schoolInfo.SCHUL_NM}-${grade}학년-${cls}반${department ? '-' + department : ''}`;
    const channel = await interaction.guild.channels.create({
      name: channelName,
      type: 0,
      permissionOverwrites: [
        {
          id: interaction.guild.id,
          allow: ['ViewChannel', 'SendMessages'],
        },
      ],
    });

    if (!schoolData.guilds[guildId]) schoolData.guilds[guildId] = { channels: {} };
    schoolData.guilds[guildId].channels[channel.id] = {
      schoolName: schoolInfo.SCHUL_NM,
      schoolCode: schoolInfo.SD_SCHUL_CODE,
      officeCode: schoolInfo.ATPT_OFCDC_SC_CODE,
      grade,
      class: cls,
      department
    };
    saveSchoolData();

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('학교 등록 및 채널 생성 완료')
      .setDescription(`<#${channel.id}> 채널이 생성되었습니다.\n${schoolInfo.SCHUL_NM} ${grade}학년 ${cls}반 ${department}로 설정됨.`)
      .addFields({ name: '사용 가능한 명령어', value: '/급식, /시간표 (이 채널에서만 사용 가능)' });

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === '급식') {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const schoolInfo = schoolData.guilds[guildId]?.channels[channelId];

    if (!schoolInfo) {
      await interaction.reply({ content: '이 채널은 학교와 학급이 설정된 전용 채널이 아닙니다. /학교등록을 사용해 전용 채널을 생성하세요.', ephemeral: true });
      return;
    }

    const today = new Date();
    const requestedDate = interaction.options.getString('날짜') || formatDate(today).formatted;
    await showMealInfo(interaction, requestedDate, schoolInfo);
  } else if (commandName === '시간표') {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const schoolInfo = schoolData.guilds[guildId]?.channels[channelId];

    if (!schoolInfo) {
      await interaction.reply({ content: '이 채널은 학교와 학급이 설정된 전용 채널이 아닙니다. /학교등록을 사용해 전용 채널을 생성하세요.', ephemeral: true });
      return;
    }

    const today = new Date();
    const requestedDate = interaction.options.getString('날짜') || formatDate(today).formatted;
    await showTimeTableInfo(interaction, schoolInfo, requestedDate);
  }
});

async function showMealInfo(interaction, dateStr, schoolInfo, selectedMealType = null, isUpdate = false) {
  const date = new Date(dateStr);
  const { year, month, day, formatted } = formatDate(date);

  try {
    const mealData = await getMealData(schoolInfo.officeCode, schoolInfo.schoolCode, formatted);

    if (mealData === undefined || mealData.dishName.includes('급식 정보가 없습니다.')) {
      const embed = new EmbedBuilder()
        .setColor('#FF5733')
        .setTitle(`${formatted} ${getDayOfWeek(formatted)}요일 급식 정보`)
        .addFields({ name: '급식 정보가 없습니다.', value: '\u200B' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`meal|${formatted}|prev`)
          .setLabel('이전 날짜')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`meal|${formatted}|next`)
          .setLabel('다음 날짜')
          .setStyle(ButtonStyle.Secondary)
      );

      if (isUpdate) {
        await interaction.update({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      return;
    }

    let mealTypes = ['조식', '중식', '석식'];
    let mealIndexToShow = 0;

    if (selectedMealType) {
      mealIndexToShow = mealTypes.indexOf(selectedMealType);
    } else if (mealData.mealName.length > 0) {
      const hour = new Date().getHours();
      if (hour < 9) mealIndexToShow = 0;
      else if (hour < 14) mealIndexToShow = 1;
      else mealIndexToShow = 2;
      if (!mealData.mealName.includes(mealTypes[mealIndexToShow])) {
        mealIndexToShow = mealData.mealName.indexOf(mealData.mealName[0]);
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`${formatted} ${getDayOfWeek(formatted)}요일 급식 정보`)
      .setDescription(`현재 보고 있는 급식: ${mealData.mealName[mealIndexToShow] || '없음'}\n${schoolInfo.schoolName}`);

    const mealIndex = mealData.mealName.indexOf(mealTypes[mealIndexToShow]);
    if (mealIndex !== -1) {
      embed.addFields({ name: mealData.mealName[mealIndex], value: mealData.dishName[mealIndex]?.split(' ').join('\n') || '정보 없음' });
    } else {
      embed.addFields({ name: '선택한 급식이 없습니다.', value: '다른 급식을 선택해주세요.' });
    }

    const mealTypeButtons = new ActionRowBuilder();
    mealTypes.forEach(type => {
      mealTypeButtons.addComponents(
        new ButtonBuilder()
          .setCustomId(`mealType|${formatted}|${type}`)
          .setLabel(type)
          .setStyle(mealData.mealName.includes(type) ? 
            (selectedMealType === type ? ButtonStyle.Primary : ButtonStyle.Secondary) : 
            ButtonStyle.Secondary)
          .setDisabled(!mealData.mealName.includes(type))
      );
    });

    const navigationButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`meal|${formatted}|prev`)
        .setLabel('이전 날짜')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`meal|${formatted}|next`)
        .setLabel('다음 날짜')
        .setStyle(ButtonStyle.Secondary)
    );

    if (isUpdate) {
      await interaction.update({ embeds: [embed], components: [mealTypeButtons, navigationButtons] });
    } else {
      await interaction.reply({ embeds: [embed], components: [mealTypeButtons, navigationButtons] });
    }
  } catch (error) {
    console.error("Error fetching meal data:", error);
    await interaction.reply({ content: "급식 정보를 불러오는데 문제가 발생했습니다.", ephemeral: true });
  }
}

async function showTimeTableInfo(interaction, schoolInfo, dateStr, isUpdate = false) {
  const date = new Date(dateStr);
  const { year, month, day, formatted } = formatDate(date);

  try {
    const timeTableData = await getTimeTableData(
      schoolInfo.officeCode,
      schoolInfo.schoolCode,
      schoolInfo.grade,
      schoolInfo.class,
      schoolInfo.department,
      year,
      month,
      day
    );

    if (timeTableData === undefined || timeTableData[0] === '시간표 정보가 없습니다.') {
      const embed = new EmbedBuilder()
        .setColor('#FF5733')
        .setTitle(`${formatted} ${getDayOfWeek(formatted)}요일 시간표 정보`)
        .setDescription('시간표 정보가 없습니다.');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`timetable|${formatted}|prev`)
          .setLabel('이전 날짜')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`timetable|${formatted}|next`)
          .setLabel('다음 날짜')
          .setStyle(ButtonStyle.Secondary)
      );

      if (isUpdate) {
        await interaction.update({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      return;
    }

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`${formatted} ${getDayOfWeek(formatted)}요일 시간표 정보`)
      .setDescription(`${schoolInfo.schoolName} ${schoolInfo.grade}학년 ${schoolInfo.class}반 ${schoolInfo.department || ''}`);

    for (let i = 0; i < timeTableData.length; i++) {
      embed.addFields({ name: `${i + 1}교시`, value: timeTableData[i] });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`timetable|${formatted}|prev`)
        .setLabel('이전 날짜')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`timetable|${formatted}|next`)
        .setLabel('다음 날짜')
        .setStyle(ButtonStyle.Secondary)
    );

    if (isUpdate) {
      await interaction.update({ embeds: [embed], components: [row] });
    } else {
      await interaction.reply({ embeds: [embed], components: [row] });
    }
  } catch (error) {
    console.error("Error fetching timetable data:", error);
    await interaction.reply({ content: "시간표 정보를 불러오는데 문제가 발생했습니다.", ephemeral: true });
  }
}

async function getAvailableMealTypes(officeCode, schoolCode, date) {
  const mealData = await getMealData(officeCode, schoolCode, date);
  return mealData.mealName;
}

async function sendMealInfoAutomatically(mealType, hour, minute) {
  const now = new Date();
  const formattedDate = formatDate(now).formatted;

  for (const guildId in schoolData.guilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const channelId in schoolData.guilds[guildId].channels) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) continue;

      const schoolInfo = schoolData.guilds[guildId].channels[channelId];
      const availableMealTypes = await getAvailableMealTypes(
        schoolInfo.officeCode,
        schoolInfo.schoolCode,
        formattedDate
      );

      if (availableMealTypes.includes(mealType)) {
        const mealData = await getMealData(
          schoolInfo.officeCode,
          schoolInfo.schoolCode,
          formattedDate
        );
        const mealIndex = mealData.mealName.indexOf(mealType);
        if (mealIndex !== -1) {
          const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`${formattedDate} ${getDayOfWeek(formattedDate)}요일 ${mealType}`)
            .setDescription(`${schoolInfo.schoolName}`)
            .addFields({
              name: mealType,
              value: mealData.dishName[mealIndex].split(' ').join('\n') || '정보 없음',
            });

          await channel.send({ embeds: [embed] });
        }
      }
    }
  }
}

async function getMealData(officeCode, schoolCode, date1) {
  const date = date1.replace(/-/g, '');
  const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?Key=${process.env.KEY}&Type=json&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}&MLSV_YMD=${date}`;
  try {
    const response = await axios.get(url);
    if (!response.data.mealServiceDietInfo) {
      return { "dishName": ['급식 정보가 없습니다.'], "mealName": [], "orplc": [] };
    }
    const mealData = response.data.mealServiceDietInfo[1].row;
    let dishNames = mealData.map(meal => meal.DDISH_NM);
    let mealName = mealData.map(meal => meal.MMEAL_SC_NM);
    let orplc = mealData.map(meal => meal.ORPLC_INFO);
    dishNames = dishNames.map(dish => {
      return dish.replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').replace(/\*/g, '').replace(/\./g, '');
    });
    return { "dishName": dishNames, "mealName": mealName, "orplc": orplc };
  } catch (error) {
    console.error(`Error fetching meal data: ${error}`);
    return { "dishName": ['급식 정보가 없습니다.'], "mealName": [], "orplc": [] };
  }
}

async function getTimeTableData(officeCode, schoolCode, grade, cls, dep, year, month, date) {
  const url = `https://open.neis.go.kr/hub/hisTimetable?Key=${process.env.KEY}&Type=json&ATPT_OFCDC_SC_CODE=${officeCode}&SD_SCHUL_CODE=${schoolCode}&GRADE=${grade}&CLASS_NM=${cls}&DDDEP_NM=${dep}&ALL_TI_YMD=${year}${month}${date}`;
  try {
    const response = await axios.get(url);
    if (response.status !== 200 || !response.data.hisTimetable) {
      return ['시간표 정보가 없습니다.'];
    }
    const timeTable = response.data.hisTimetable[1].row;
    let timeTableNames = timeTable.map(meal => meal.ITRT_CNTNT);
    return timeTableNames;
  } catch (error) {
    console.error(`Error fetching timetable data: ${error}`);
    return ['시간표 정보가 없습니다.'];
  }
}

client.login(process.env.DISCORD_TOKEN);