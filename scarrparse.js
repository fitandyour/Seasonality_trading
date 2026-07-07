const MONTH_NUM = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

function parseSavedChartUrl(url) {
  const u = new URL(url);
  const raw = u.searchParams.get('newGeneralForm');
  if (!raw) throw new Error('URL has no newGeneralForm parameter');
  const form = JSON.parse(raw);
  return {
    saveName: form.saveName,
    legs: form.legs,
    selected: form.selected || [],
    yearsBack: form.y1 || 5,
    window: {
      openMonth: form.openMonth, openDate: form.openDate,
      closeMonth: form.closeMonth, closeDate: form.closeDate,
    },
    startDate: form.startDate,
    endDate: form.endDate,
    form,
  };
}

module.exports = { parseSavedChartUrl, MONTH_NUM };
