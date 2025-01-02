import pkg from 'discord.js';
import dotenv from 'dotenv';
import { getMealData } from './mealData.js';
import { getTimeTableData } from './timeTableData.js';

const { Client, EmbedBuilder, GatewayIntentBits, Events, ActivityType } = pkg;
dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

client.on(Events.ClientReady, async () => {
  setInterval(() => {
    client.user.setPresence({
      activities: [{ name: "자바 잡기", type: ActivityType.Playing }],
    });
  }, 1000);

  try {
    await client.application.commands.create({
      name: '급식',
      description: '특정 날짜의 급식 정보를 알려줍니다.',
      options: [
        {
          name: '년',
          description: '급식 정보를 확인할 날짜 (YYYY 형식)',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
        {
          name: '월',
          description: '급식 정보를 확인할 날짜 (MM 형식)',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
        {
          name: '일',
          description: '급식 정보를 확인할 날짜 (DD 형식)',
          required: true,
          type: pkg.ApplicationCommandOptionType.String,
        },
      ],
    });

    await client.application.commands.create({
      name: '시간표',
      description: '특정 날짜의 시간표 정보를 알려줍니다.',
      options: [
      {
        name: '학과',
        description: '시간표 정보를 확인할 학과',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
        choices: [
        { name: '뉴미디어소프트웨어과', value: '뉴미디어소프트웨어과' },
        { name: '뉴미디어디자인과', value: '뉴미디어디자인과' },
        ],
      },
      {
        name: '학년',
        description: '시간표 정보를 확인할 학년',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
        choices: [
        { name: '1학년', value: '1' },
        { name: '2학년', value: '2' },
        { name: '3학년', value: '3' },
        ],
      },
      {
        name: '반',
        description: '시간표 정보를 확인할 반',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
        choices: [
        { name: '1반', value: '1' },
        { name: '2반', value: '2' },
        { name: '3반', value: '3' },
        { name: '4반', value: '4' },
        { name: '5반', value: '5' },
        { name: '6반', value: '6' },
        ],
      },
      {
        name: '월',
        description: '시간표 정보를 확인할 월 (MM 형식)',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
      },
      {
        name: '일',
        description: '시간표 정보를 확인할 날짜 (DD 형식)',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
      },
      ],
    });

    await client.application.commands.create({
      name: '급식',
      description: '특정 날짜의 급식 정보를 알려줍니다.',
      options: [
      {
        name: '년',
        description: '급식 정보를 확인할 날짜 (YYYY 형식)',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
      },
      {
        name: '월',
        description: '급식 정보를 확인할 날짜 (MM 형식)',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
      },
      {
        name: '일',
        description: '급식 정보를 확인할 날짜 (DD 형식)',
        required: true,
        type: pkg.ApplicationCommandOptionType.String,
      },
      ],
    });
  } catch (error) {
    console.error(error);
  }
});

function getDayOfWeek(yyyyMMdd){
  const day = ['일', '월', '화', '수', '목', '금', '토'];
	
  const dayOfWeek = new Date(yyyyMMdd).getDay(); 

  return day[dayOfWeek];
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  if (commandName === '급식') {
    const year = interaction.options.get('년').value;
    let month = interaction.options.get('월').value;
    let day = interaction.options.get('일').value;
    month = String(month).padStart(2, '0');
    day = String(day).padStart(2, '0');
    
    const date = year + "-" + month + "-" + day
    try {
      const mealData = await getMealData(date);
      if (mealData === undefined || mealData.dishName.includes('급식 정보가 없습니다.')) {
        const embed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle(`${date} ${getDayOfWeek(date)}요일 급식 정보`)
          .addFields({name: '급식 정보가 없습니다.', value: '\u200B'});

        await interaction.reply({ embeds: [embed] });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`${date} ${getDayOfWeek(date)}요일 급식 정보`)

      for(let i = 0; i < mealData.dishName.length; i++) {
        embed.addFields({ name: '\u200B', value: '\u200B' }, 
        { name: mealData.mealName[i], value: mealData.dishName[i]?.split(' ').join('\n') || '' });
      }

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Error fetching meal data:", error);
      await interaction.reply("급식 정보를 불러오는데 문제가 발생했습니다.");
    }
  } else if (commandName === '시간표') {
    const dep = interaction.options.get('학과').value;
    const grade = interaction.options.get('학년').value;
    const cls = interaction.options.get('반').value;
    let month = interaction.options.get('월').value;
    let date = interaction.options.get('일').value;
    date = String(date).padStart(2, '0');
    month = String(month).padStart(2, '0');

    try {
      const timeTableData = await getTimeTableData(cls, grade, dep, month, date);
      if (timeTableData === undefined || timeTableData[0] === '시간표 정보가 없습니다.') {
        await interaction.reply("시간표 정보가 없습니다.");
        return;
      }

      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`${dep} ${grade}학년 ${cls}반 ${date}일 시간표 정보`);

      for (let i = 0; i < timeTableData.length; i++) {
        embed.addFields({ name: `${i + 1}교시`, value: timeTableData[i] });
      }

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Error fetching meal data:", error);
      await interaction.reply("시간표 정보를 불러오는데 문제가 발생했습니다.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
