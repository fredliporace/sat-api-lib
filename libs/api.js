'use strict';

var _ = require('lodash')
var moment = require('moment')
var area = require('turf-area')
var intersect = require('turf-intersect')
var logger = require('./logger')
var queries = require('./queries')
var aggregations = require('./aggregations')

const API_URL = process.env.API_URL || 'https://sat-api.developmentseed.org'

// converts string intersect to js object
var intersectsToObj = function (intersects) {
  if (_.isString(intersects)) {
    try {
      intersects = JSON.parse(intersects);
    } catch (e) {
      throw new Error('Invalid Geojson');
    }
  }

  return intersects;
};

// Search class
function Search(event, esClient) {
  var params;

  if (_.has(event, 'query') && !_.isEmpty(event.query)) {
    params = event.query;
  } else if (_.has(event, 'body') && !_.isEmpty(event.body)) {
    params = event.body;
  } else {
    params = {};
  }

  // AOI Coverage
  this.aoiCoverage = null;
  if (_.has(params, 'coverage')) {
    this.aoiCoverage = params['coverage'];
    params = _.omit(params, ['coverage']);
  }

  // get page number
  var page = parseInt((params.page) ? params.page : 1);

  this.params = params;
  console.log('Search parameters:', params);

  this.size = parseInt((params.limit) ? params.limit : 1);
  this.frm = (page - 1) * this.size;
  this.page = parseInt((params.skip) ? params.skip : page);
  this.client = esClient
};

var aoiCoveragePercentage = function (feature, scene, aoiArea) {
  var intersectObj = intersect(feature, scene);
  if (intersectObj === undefined) {
    return 0;
  }

  var intersectArea = area(intersectObj);
  var percentage = (intersectArea / aoiArea) * 100;

  return percentage;
};

Search.prototype.calculateAoiCoverage = function (response) {
  var self = this;
  if (this.aoiCoverage && _.has(this.params, 'intersects')) {
    this.params.intersects = intersectsToObj(this.params.intersects);
    var coverage = parseFloat(this.aoiCoverage);
    var newResponse = [];
    var aoiArea = area(self.params.intersects);

    response.forEach(function (r) {
      var gj = self.params.intersects;
      var percentage = 0;

      if (gj.type === 'FeatureCollection') {
        gj.features.forEach(function (f) {
          percentage += aoiCoveragePercentage(f.geometry, r.data_geometry, aoiArea);
        });
      } else if (gj.type === 'Feature') {
        percentage = aoiCoveragePercentage(gj.geometry, r.data_geometry, aoiArea);
      } else if (gj.type === 'Polygon') {
        percentage = aoiCoveragePercentage(gj, r.data_geometry, aoiArea);
      }

      if (percentage >= coverage) {
        newResponse.push(r);
      }
    });

    return newResponse;
  } else {
    return response;
  }
};

Search.prototype.buildSearch = function (index='items') {
  var fields;

  // if fields are included remove it from params
  if (_.has(this.params, 'fields')) {
    fields = this.params.fields;
    this.params = _.omit(this.params, ['fields'])
  }

  return {
    index: index,
    body: queries(this.params),
    size: this.size,
    from: this.frm,
    _source: fields
  }
}

// search for items using collection and items
Search.prototype.search_items = function(callback) {
  // check collection first
  this.search('collections', (err, resp) => {
    console.log(resp)
    return this.search('items', callback)
  })
}


Search.prototype.search = function (index, callback) {
  var self = this;
  var searchParams;

  try {
    searchParams = this.buildSearch(index=index)
  } catch (e) {
    return callback(e, null)
  }

  console.log(`Queries: ${JSON.stringify(searchParams)}`)

  this.client.search(searchParams).then(function (body) {
    console.log(`body: ${JSON.stringify(body)}`)
    var count = body.hits.total;

    var response = {
      type: 'FeatureCollection',
      properties: {
        found: count,
        limit: self.size,
        page: self.page
      },
      features: []
    }

    for (var i = 0; i < body.hits.hits.length; i++) {
      var props = body.hits.hits[i]._source
      props = _.omit(props, ['bbox', 'geometry', 'assets', 'links', 'eo:bands'])
      var links = body.hits.hits[i]._source.links || []
      // update relative links to absolute
      links.forEach((el) => {
        if (el['rel'] === 'collection')
          el['href'] = `${API_URL}${el['href']}`
      })
      // add self link
      let prefix = '/search/stac'
      if (index === 'collections')
        prefix = '/collections'
      links.push({'ref': 'self', 'href': `${API_URL}${prefix}?id=${props['id']}`})
      response.features.push({
        type: 'Feature',
        properties: props,
        bbox: body.hits.hits[i]._source.bbox,
        geometry: body.hits.hits[i]._source.geometry,
        assets: body.hits.hits[i]._source.assets,
        links,
        'eo:bands': body.hits.hits[i]._source['eo:bands']
      })
    }

    return callback(null, response);
  }, function (err) {
    logger.error(err)
    return callback(err)
  });
}


module.exports = Search