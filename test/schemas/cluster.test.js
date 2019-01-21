var server = require('../../server');
var db = require('../../models/db');

var chai = require('chai');
var chaiHttp = require('chai-http');
var should = chai.should();

chai.use(chaiHttp);

describe('cluster', function () {
    before(function(){
        db.loadFromFile('test/schemas/cluster.data.json');
    });

    it('serves a basic graphql query', function (done) {
        chai.request(server)
            .get('/graphql')
            .query({'query': '{ cluster { name } }'})
            .end(function (err, res) {
                res.should.have.status(200);
                res.body.data.cluster[0].name.should.equal("example cluster");
                done();
            });
    });
});
