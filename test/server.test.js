var server = require('../server');
var db = require('../models/db');

var chai = require('chai');
var chaiHttp = require('chai-http');
var should = chai.should();

chai.use(chaiHttp);


describe('server', function () {
    before(function(){
        db.loadFromFile('test/server.data.json');
    });

    it('GET /sha256 returns a valid sha256', function (done) {
        chai.request(server)
            .get('/sha256')
            .end(function (err, res) {
                res.text.length.should.equal(64);
                done();
            });
    });

    it("resolves refs", function (done) {
        var query = `{
            role {
                name
                permissions {
                    service
                }
            }
        }`;

        chai.request(server)
        .get('/graphql')
        .query({'query': query})
        .end(function (err, res) {
            res.should.have.status(200);
            var permissionsName = res.body.data.role[0].permissions[0].service;
            permissionsName.should.equal("github-org-team");
            done();
        });
    });
});
