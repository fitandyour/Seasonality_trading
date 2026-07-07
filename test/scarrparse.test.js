const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSavedChartUrl, MONTH_NUM } = require('../scarrparse');

const REAL_URL = 'https://scarrtrading.com/SeasonalsGenerator.action?newGeneralForm=%7B%22json%22:%22%22,%22chartType%22:%22amcharts%22,%22grouping%22:%22off%22,%22balloons%22:false,%22lineWidth%22:1,%22height%22:750,%22width%22:950,%22legendLocation%22:%22bottom%22,%22legsPanel%22:%22yes%22,%22study%22:%22stacked%22,%22generator%22:%22SeasonalsGenerator%22,%22startDate%22:%222026-04-29T22:00:00.000Z%22,%22endDate%22:%222026-12-14T23:00:00.000Z%22,%22hiddenAmchartsItems%22:%5B%22FC2013J/FC2013K%22%5D,%22eye%22:%5B1.9,0.93,0.31%5D,%22sampleContract%22:%5B%22FC2027H%22,%22FC2027J%22,%22FC2027K%22%5D,%22saveName%22:%22Feeder%20cattle_A_%20HJK%22,%22legs%22:3,%22intracommodity%22:true,%22mult%22:%5B1,2,1,1%5D,%22p%22:%5B1,-1,1,1%5D,%22unitMove%22:%5B500,500,500,500%5D,%22openMonth%22:%22January%22,%22openDate%22:1,%22closeMonth%22:%22February%22,%22closeDate%22:1,%22y1%22:5,%22method%22:%22average%22,%22normalization%22:%22off%22,%22normalizationMonth%22:%22January%22,%22normalizationDate%22:1,%22truncate%22:1.5,%22addCOTPanel%22:true,%22selected%22:%5B%22FC2027H/FC2027J/FC2027K%22,%22FC2026H/FC2026J/FC2026K%22,%22FC2025H/FC2025J/FC2025K%22,%22FC2024H/FC2024J/FC2024K%22,%22FC2023H/FC2023J/FC2023K%22,%22FC2022H/FC2022J/FC2022K%22,%22FC2021H/FC2021J/FC2021K%22,%22FC2020H/FC2020J/FC2020K%22%5D,%22seasonalSelectionMode%22:%22custom%22,%22seasonals%22:%5B5,15%5D,%22database%22:%22saves%22,%22language%22:%22en%22%7D';

test('parses saved chart URL into strategy config', () => {
  const cfg = parseSavedChartUrl(REAL_URL);
  assert.equal(cfg.saveName, 'Feeder cattle_A_ HJK');
  assert.equal(cfg.legs, 3);
  assert.equal(cfg.yearsBack, 5);
  assert.equal(cfg.selected.length, 8);
  assert.equal(cfg.selected[0], 'FC2027H/FC2027J/FC2027K');
  assert.deepEqual(cfg.window, { openMonth: 'January', openDate: 1, closeMonth: 'February', closeDate: 1 });
  assert.equal(cfg.form.study, 'stacked');
  assert.equal(new Date(cfg.startDate).getUTCMonth() + 1, 4);
});

test('throws on URL without newGeneralForm', () => {
  assert.throws(() => parseSavedChartUrl('https://scarrtrading.com/Home.action'),
    /newGeneralForm/);
});

test('MONTH_NUM maps names', () => {
  assert.equal(MONTH_NUM.January, 1);
  assert.equal(MONTH_NUM.December, 12);
});
