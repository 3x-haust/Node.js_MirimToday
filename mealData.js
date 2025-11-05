import axios from 'axios';

export async function getMealData(date1) {
  const date = date1.replace(/-/g, '');
  const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?Key=41f6e5e991b3408d8a1b6a390d79f803&Type=json&ATPT_OFCDC_SC_CODE=B10&SD_SCHUL_CODE=7011569&MLSV_YMD=${date}`;

  try {
    const response = await axios.get(url);
    if(response.data.mealServiceDietInfo == undefined)  return {"dishName" : '급식 정보가 없습니다.'};

    const mealData = response.data.mealServiceDietInfo[1].row;
    let dishNames = mealData.map(meal => meal.DDISH_NM);
    let mealName = mealData.map(meal => meal.MMEAL_SC_NM);
    let orplc = mealData.map(meal => meal.ORPLC_INFO);

    dishNames = dishNames.map(dish => {
      const cleaned = dish.replace(/<br\s*\/?>/gi, '\n');
      const items = cleaned.split('\n')
        .map(item => item.trim())
        .filter(item => item.length > 0)
        .map(item => {
          return item.replace(/\([^)]*\)/g, '').replace(/\*/g, '').replace(/\./g, '').trim();
        })
        .filter(item => item.length > 0);
      
      return items;
    });
    
    return {"dishName" : dishNames, "mealName": mealName, "orplc": orplc};
  } catch (error) {
    console.error(`Error fetching meal data: ${error}`);
  }
}

await getMealData('2025-11-05');