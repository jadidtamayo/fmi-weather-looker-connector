**
 * Returns the Auth Type required by the connector.
 * Since this is a public open data API, we return NONE.
 */
function getAuthType() {
  var cc = DataStudioApp.createCommunityConnector();
  var AuthTypes = cc.AuthType;
  return cc
    .newAuthTypeResponse()
    .setAuthType(AuthTypes.NONE)
    .build();
}

/**
 * Returns the Configuration options for the connector.
 * Allows the user to select the city name in Finland.
 */
function getConfig(request) {
  var cc = DataStudioApp.createCommunityConnector();
  var config = cc.getConfig();

  config
    .newInfo()
    .setId('instructions')
    .setText('Configure the weather forecast location. Enter a city name in Finland to fetch a 7-day hourly temperature forecast.');

  config
    .newTextInput()
    .setId('place')
    .setName('City Name')
    .setHelpText('Enter a city name in Finland (e.g. Tampere, Helsinki, Oulu)')
    .setPlaceholder('Tampere')
    .setAllowOverride(true);

  return config.build();
}

/**
 * Helper function to define the fields schema.
 */
function getFields() {
  var cc = DataStudioApp.createCommunityConnector();
  var fields = cc.getFields();
  var types = cc.FieldType;
  var aggregations = cc.AggregationType;

  fields.newDimension()
    .setId('datetime')
    .setName('Timestamp')
    .setType(types.YEAR_MONTH_DAY_HOUR);

  fields.newDimension()
    .setId('location')
    .setName('Location')
    .setType(types.TEXT);

  fields.newDimension()
    .setId('weathersymbol3')
    .setName('Weather Symbol Code')
    .setType(types.NUMBER);

  fields.newMetric()
    .setId('temperature')
    .setName('Temperature (°C)')
    .setType(types.NUMBER)
    .setAggregation(aggregations.AVG);

  fields.newMetric()
    .setId('windspeed')
    .setName('Wind Speed (m/s)')
    .setType(types.NUMBER)
    .setAggregation(aggregations.AVG);

  fields.newMetric()
    .setId('precipitation')
    .setName('Precipitation (mm)')
    .setType(types.NUMBER)
    .setAggregation(aggregations.SUM);

  return fields;
}

/**
 * Returns the Schema for the connector.
 */
function getSchema(request) {
  var fields = getFields();
  return { schema: fields.build() };
}

/**
 * Fetches, parses, and returns the weather forecast data to Looker Studio.
 */
function getData(request) {
  var place = (request.configParams && request.configParams.place) || 'Tampere';
  
  // Get the requested fields
  var requestedFields = getFields().forIds(
    request.fields.map(function(field) {
      return field.name;
    })
  );

  var rows = [];
  try {
    // Fetch forecast data from FMI WFS API
    var weatherData = fetchWeatherData(place);
    
    // Map data to the Looker Studio row format
    weatherData.forEach(function(item) {
      var values = [];
      requestedFields.asArray().forEach(function(field) {
        var fieldId = field.getId();
        if (fieldId === 'datetime') {
          values.push(item.datetime);
        } else if (fieldId === 'location') {
          values.push(item.location);
        } else if (fieldId === 'weathersymbol3') {
          values.push(item.weathersymbol3);
        } else if (fieldId === 'temperature') {
          values.push(item.temperature);
        } else if (fieldId === 'windspeed') {
          values.push(item.windspeed);
        } else if (fieldId === 'precipitation') {
          values.push(item.precipitation);
        } else {
          values.push(null);
        }
      });
      rows.push({ values: values });
    });
  } catch (e) {
    var cc = DataStudioApp.createCommunityConnector();
    cc.newUserError()
      .setDebugText('Error fetching weather data from FMI. Exception details: ' + e)
      .setText('The connector was unable to fetch the weather forecast. Please check that you entered a valid city in Finland.')
      .throwException();
  }

  return {
    schema: requestedFields.build(),
    rows: rows
  };
}

/**
 * Fetches raw XML weather forecast data from the FMI API.
 */
function fetchWeatherData(place) {
  var now = new Date();
  var start = now.toISOString().split('.')[0] + 'Z';
  // Calculate end date (7 days from now)
  var end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('.')[0] + 'Z';
  
  var url = [
    'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature',
    'storedquery_id=ecmwf::forecast::surface::point::timevaluepair',
    'place=' + encodeURIComponent(place),
    'parameters=temperature,windspeedms,precipitation1h,WeatherSymbol3', // Fetch all 4 variables from FMI
    'timestep=60', // Hourly data
    'starttime=' + start,
    'endtime=' + end
  ].join('&');
  
  var response = UrlFetchApp.fetch(url);
  var xmlText = response.getContentText();
  
  return parseFmiXml(xmlText, place);
}

/**
 * Parses FMI WFS XML weather data using Google Apps Script XmlService.
 * Pivots timeseries data of multiple parameters by timestamp.
 */
function parseFmiXml(xmlText, place) {
  var doc = XmlService.parse(xmlText);
  var root = doc.getRootElement();
  
  var wfsNamespace = XmlService.getNamespace('wfs', 'http://www.opengis.net/wfs/2.0');
  var omNamespace = XmlService.getNamespace('om', 'http://www.opengis.net/om/2.0');
  var omsoNamespace = XmlService.getNamespace('omso', 'http://inspire.ec.europa.eu/schemas/omso/3.0');
  var wml2Namespace = XmlService.getNamespace('wml2', 'http://www.opengis.net/waterml/2.0');
  var xlinkNamespace = XmlService.getNamespace('xlink', 'http://www.w3.org/1999/xlink');

  // We group observations by timestamp to return a single tabular row per hour
  var recordsMap = {};

  var members = root.getChildren('member', wfsNamespace);
  members.forEach(function(member) {
    var observation = member.getChild('PointTimeSeriesObservation', omsoNamespace);
    if (!observation) return;

    var observedPropertyEl = observation.getChild('observedProperty', omNamespace);
    if (!observedPropertyEl) return;

    var href = observedPropertyEl.getAttribute('href', xlinkNamespace).getValue();
    var paramMatch = href.match(/param=([^&]+)/i);
    if (!paramMatch) return;
    var paramName = paramMatch[1].toLowerCase();

    var resultEl = observation.getChild('result', omNamespace);
    if (!resultEl) return;

    var timeseries = resultEl.getChild('MeasurementTimeseries', wml2Namespace);
    if (!timeseries) return;

    var points = timeseries.getChildren('point', wml2Namespace);
    points.forEach(function(point) {
      var tvp = point.getChild('MeasurementTVP', wml2Namespace);
      if (!tvp) return;

      var timeEl = tvp.getChild('time', wml2Namespace);
      var valueEl = tvp.getChild('value', wml2Namespace);
      if (!timeEl || !valueEl) return;

      var timeStr = timeEl.getText();  // e.g. 2026-07-06T20:00:00Z
      var valStr = valueEl.getText();  // e.g. 13.1
      var val = parseFloat(valStr);

      if (!isNaN(val)) {
        if (!recordsMap[timeStr]) {
          var datetime = Utilities.formatDate(new Date(timeStr),'UTC','yyyyMMddHH');
          recordsMap[timeStr] = {
            datetime: datetime,
            location: capitalize(place),
            temperature: null,
            windspeed: null,
            precipitation: null,
            weathersymbol3: null
          };
        }

        if (paramName === 'temperature') {
          recordsMap[timeStr].temperature = val;
        } else if (paramName === 'windspeedms') {
          recordsMap[timeStr].windspeed = val;
        } else if (paramName === 'precipitation1h' || paramName === 'precipitationamount') {
          recordsMap[timeStr].precipitation = val;
        } else if (paramName === 'weathersymbol3') {
          recordsMap[timeStr].weathersymbol3 = val;
        }
      }
    });
  });

  // Convert map to sorted array by time
  var sortedTimes = Object.keys(recordsMap).sort();
  var weatherRecords = sortedTimes.map(function(t) {
    var rec = recordsMap[t];
    
    // Set default values for missing/unreturned parameters
    if (rec.temperature === null) rec.temperature = 0;
    if (rec.windspeed === null) rec.windspeed = 0;
    if (rec.precipitation === null) rec.precipitation = 0;
    if (rec.weathersymbol3 === null) rec.weathersymbol3 = 1; // Default to 1 (Clear/Sunny)

    return rec;
  });

  return weatherRecords;
}

/**
 * Recursive helper to find elements in an XML tree by name and namespace.
 */
function getElementsByName(element, name, namespace) {
  var result = [];
  
  // Check if the current element matches
  if (element.getName() === name && element.getNamespace().getURI() === namespace.getURI()) {
    result.push(element);
  }
  
  // Recurse into children
  var children = element.getChildren();
  for (var i = 0; i < children.length; i++) {
    result = result.concat(getElementsByName(children[i], name, namespace));
  }
  
  return result;
}

/**
 * Capitalizes the first letter of a string.
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Local testing function to execute and debug FMI queries in the editor console.
 */
function testConnector() {
  console.log("=== Auth Type Response ===");
  console.log(JSON.stringify(getAuthType(), null, 2));

  console.log("\n=== Config Response ===");
  console.log(JSON.stringify(getConfig(), null, 2));

  console.log("\n=== Schema Response ===");
  console.log(JSON.stringify(getSchema({}), null, 2));

  console.log("\n=== Data Response (Real API query for Tampere, first 5 rows shown) ===");
  var req = {
    configParams: { place: 'Tampere' },
    fields: [
      { name: 'datetime' },
      { name: 'location' },
      { name: 'temperature' },
      { name: 'windspeed' },
      { name: 'precipitation' },
      { name: 'weathersymbol3' }
    ]
  };
  
  try {
    // Note: This call will execute a live HTTP request to FMI WFS API
    var response = getData(req);
    console.log("Total forecast rows fetched: " + response.rows.length);
    console.log("Schema: " + JSON.stringify(response.schema, null, 2));
    console.log("First 5 rows: " + JSON.stringify(response.rows.slice(0, 5), null, 2));
  } catch (e) {
    console.log("Error running getData test: " + e);
  }
}
